from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from backend.api.config import yaml_service
from backend.auth.dependencies import ensure_profile_access, get_current_user
from backend.db.models import User
from backend.services.env_service import EnvService
from backend.services.yaml_service import YamlService


router = APIRouter(prefix="/models", tags=["models"])

MODEL_SECTIONS = [
    "model",
    "auxiliary",
    "fallback_providers",
    "custom_providers",
    "providers",
    "models",
    "model_catalog",
    "moa",
]


@router.get("")
def get_models(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    """返回模型相关的组合配置：model / auxiliary / fallback_providers"""
    config = service.read_config(ensure_profile_access(user, profile))
    if not isinstance(config, dict):
        return {"model": {}, "auxiliary": {}, "fallback_providers": []}

    result: dict[str, Any] = {}
    for section in MODEL_SECTIONS:
        result[section] = config.get(section, {} if section != "fallback_providers" else [])
    return result


@router.put("/{section}")
def update_model_section(
    section: str,
    payload: dict[str, Any] | list[Any],
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    """更新 model / auxiliary / fallback_providers 中的某一个 section"""
    if section not in MODEL_SECTIONS:
        raise HTTPException(status_code=400, detail=f"Invalid section: {section}")
    service.write_section(ensure_profile_access(user, profile), section, payload)
    return {"ok": True, "section": section}


@router.delete("/providers/{name}")
def delete_provider(
    name: str,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    yaml_svc: YamlService = Depends(yaml_service),
):
    profile_name = ensure_profile_access(user, profile)
    config = yaml_svc.read_config(profile_name)
    if not isinstance(config, dict):
        raise HTTPException(status_code=500, detail="Invalid config")

    env_svc = EnvService(yaml_svc.profiles.hermes_home)
    env_vars = env_svc.read_env(profile_name)
    providers = _collect_providers_from_config_and_env(config, env_vars)
    provider = next((p for p in providers if str(p.get("name", "")).lower() == name.lower()), None)
    if not provider:
        raise HTTPException(status_code=404, detail=f"Provider '{name}' not found")

    changed = False
    target_name = str(provider.get("name", name))

    custom_providers = config.get("custom_providers", [])
    if not isinstance(custom_providers, list):
        custom_providers = []
    next_custom_providers = [
        item for item in custom_providers
        if not (isinstance(item, dict) and str(item.get("name", "")).lower() == target_name.lower())
    ]
    if len(next_custom_providers) != len(custom_providers):
        yaml_svc.write_section(profile_name, "custom_providers", next_custom_providers)
        changed = True

    model_section = config.get("model", {})
    if isinstance(model_section, dict):
        current_provider = str(model_section.get("provider", "")).replace("custom:", "")
        if current_provider.lower() == target_name.lower():
            next_model = dict(model_section)
            next_model["provider"] = ""
            next_model["base_url"] = ""
            yaml_svc.write_section(profile_name, "model", next_model)
            changed = True

    key_env = str(provider.get("key_env", "") or "")
    if not key_env:
        fallback_key = f"{target_name.upper().replace('-', '_')}_API_KEY"
        if fallback_key in env_vars:
            key_env = fallback_key
    if key_env and key_env in env_vars:
        env_svc.delete_env_var(profile_name, key_env)
        changed = True

    return {"ok": True, "changed": changed, "name": target_name}


# ── 组合 Provider 列表 ─────────────────────────────────


def _load_hermes_provider_base_urls() -> dict[str, str]:
    """
    从 Hermes 源码 agent/model_metadata.py 的 _URL_TO_PROVIDER 映射
    反向推导 provider → base_url。
    用 re 和 ast 解析 dict，避免 import 依赖。
    """
    import ast
    import os
    import re
    from pathlib import Path

    hermes_home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    model_md_path = hermes_home / "hermes-agent" / "agent" / "model_metadata.py"
    if not model_md_path.exists():
        return {}

    content = model_md_path.read_text(encoding="utf-8")

    # 用正则抓出 _URL_TO_PROVIDER 的 dict literal
    m = re.search(r"^_URL_TO_PROVIDER\s*:\s*Dict\[str,\s*str\]\s*=\s*(\{.*?^\})", content, re.MULTILINE | re.DOTALL)
    if not m:
        return {}
    try:
        url_to_prov = ast.literal_eval(m.group(1))
    except Exception:
        return {}
    if not isinstance(url_to_prov, dict):
        return {}

    # 反向：provider → 最佳 hostname（优先非 api. 前缀的短 host）
    provider_host: dict[str, str] = {}
    for host, prov in url_to_prov.items():
        if prov not in provider_host:
            provider_host[prov] = host
    for prov, host in provider_host.items():
        # 跳过通配 host 和非 API 端点
        if host.startswith("."):
            continue
        if host in ("portal.qwen.ai", "chatgpt.com"):
            continue
        if host == "openrouter.ai":
            provider_host[prov] = f"https://{host}/api/v1"
        else:
            provider_host[prov] = f"https://{host}/v1"

    return {prov: url for prov, url in provider_host.items() if isinstance(url, str) and url.startswith("https://")}


def _collect_providers_from_config_and_env(
    config: dict[str, Any], env_vars: dict[str, str]
) -> list[dict[str, Any]]:
    """合并 config + .env 中的所有 provider，返回统一列表。"""
    herm_providers = _load_hermes_provider_base_urls()

    # ── 非 LLM token 排除列表 ──
    NON_LLM_PROVIDERS = frozenset({
        "feishu", "feishu_app", "weixin", "wechat",
        "discord", "telegram", "slack",
        "hass", "homeassistant", "tavily",
    })

    # 1. 主 provider（来自 model 区段）
    model_section = config.get("model", {}) if isinstance(config, dict) else {}
    main_provider_name = (model_section.get("provider", "") if isinstance(model_section, dict) else "").replace("custom:", "")
    main_base_url = model_section.get("base_url", "") if isinstance(model_section, dict) else ""

    # 2. 自定义 provider
    custom_list = config.get("custom_providers", []) if isinstance(config, dict) else []
    if not isinstance(custom_list, list):
        custom_list = []
    custom_by_name = {
        str(item.get("name", "")): item
        for item in custom_list
        if isinstance(item, dict) and item.get("name")
    }

    # 3. 从 .env 中扫描已知 LLM provider 的 API key
    env_providers: dict[str, str] = {}
    for env_key, env_val in env_vars.items():
        if not env_val:
            continue
        upper = env_key.upper()
        if upper.endswith("_API_KEY"):
            pname = upper.replace("_API_KEY", "").lower()
            if pname and pname not in NON_LLM_PROVIDERS and pname not in env_providers:
                env_providers[pname] = env_key

    # 构建结果
    seen: set[str] = set()
    result: list[dict[str, Any]] = []

    # 主 provider
    if main_provider_name:
        main_override = custom_by_name.get(main_provider_name, {})
        main_key_env = str(main_override.get("key_env", "") or "")
        main_inline_key = bool(main_override.get("api_key"))
        seen.add(main_provider_name)
        result.append({
            "name": main_provider_name,
            "source": "main",
            "base_url": str(main_override.get("base_url") or main_base_url or herm_providers.get(main_provider_name, "")),
            "api_mode": str(main_override.get("api_mode") or ""),
            "key_env": main_key_env or next((k for k, v in env_vars.items()
                            if (k.upper().startswith(main_provider_name.upper() + "_") or 
                                main_provider_name.upper() in k.upper()) and 
                            "KEY" in k.upper() and bool(v)), ""),
            "has_key": bool(env_vars.get(main_key_env)) if main_key_env else (
                main_inline_key or any((k.upper().startswith(main_provider_name.upper() + "_") or 
                                        main_provider_name.upper() in k.upper()) and bool(v) for k, v in env_vars.items())
            ),
        })

    # 自定义 provider
    for cp in custom_list:
        if not isinstance(cp, dict):
            continue
        cname = cp.get("name", "")
        if not cname or cname in seen:
            continue
        seen.add(cname)
        key_env = cp.get("key_env", "") or ""
        result.append({
            "name": cname,
            "source": "custom",
            "base_url": cp.get("base_url", "") or "",
            "api_mode": str(cp.get("api_mode") or ""),
            "key_env": key_env,
            "has_key": bool(env_vars.get(key_env)) if key_env else bool(cp.get("api_key")),
        })

    # 仅 .env 中发现的 provider（只显示有已知 base_url 的）
    for pname, env_key in sorted(env_providers.items()):
        if pname not in seen:
            base_url = herm_providers.get(pname, "")
            if not base_url:
                continue  # 无已知 base_url 就不算 LLM provider
            seen.add(pname)
            result.append({
                "name": pname,
                "source": "env",
                "base_url": base_url,
                "api_mode": "",
                "key_env": env_key,
                "has_key": True,
            })

    return result


@router.get("/providers")
def get_providers(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    yaml_svc: YamlService = Depends(yaml_service),
):
    profile_name = ensure_profile_access(user, profile)
    config = yaml_svc.read_config(profile_name)
    env_svc = EnvService(yaml_svc.profiles.hermes_home)
    env_vars = env_svc.read_env(profile_name)
    result = _collect_providers_from_config_and_env(config, env_vars)
    return {"providers": result}


# ── Provider 预设列表（来自 Hermes 源码）─────────────────────────


def _load_provider_presets() -> list[dict[str, Any]]:
    """
    从 Hermes 源码加载内置 provider 预设列表。
    数据来源：hermes_cli/providers.py 的 HERMES_OVERLAYS + model_metadata.py 的 _URL_TO_PROVIDER
    """
    import ast
    import os
    import re
    from pathlib import Path

    hermes_home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    providers_py = hermes_home / "hermes-agent" / "hermes_cli" / "providers.py"
    model_metadata_py = hermes_home / "hermes-agent" / "agent" / "model_metadata.py"

    presets: dict[str, dict[str, Any]] = {}

    # ── 辅助函数：括号匹配，提取 HermesOverlay(...) 的完整内容 ──
    def _extract_overlay_args(text: str, start: int) -> str:
        """从 start 位置的 '(' 开始，找到匹配的 ')' 返回中间内容。"""
        depth = 0
        i = start
        while i < len(text):
            if text[i] == '(':
                depth += 1
            elif text[i] == ')':
                depth -= 1
                if depth == 0:
                    return text[start + 1:i]
            i += 1
        return ""

    # ── 辅助函数：解析 HermesOverlay 的参数 ──
    def _parse_overlay_args(args_str: str) -> dict[str, Any]:
        """解析 HermesOverlay 构造函数的 keyword arguments。"""
        result: dict[str, Any] = {}
        # 匹配 key=value，value 可以是 "string"、True、False 或 (...)
        pos = 0
        while pos < len(args_str):
            km = re.search(r'(\w+)\s*=\s*', args_str[pos:])
            if not km:
                break
            key = km.group(1)
            val_start = pos + km.end()

            if val_start >= len(args_str):
                break

            ch = args_str[val_start]
            if ch == '"':
                # 字符串值
                end = args_str.index('"', val_start + 1)
                result[key] = args_str[val_start + 1:end]
                pos = end + 1
            elif args_str[val_start:val_start + 4] == 'True':
                result[key] = True
                pos = val_start + 4
            elif args_str[val_start:val_start + 5] == 'False':
                result[key] = False
                pos = val_start + 5
            elif ch == '(':
                # Tuple — 括号匹配
                depth = 0
                i = val_start
                while i < len(args_str):
                    if args_str[i] == '(':
                        depth += 1
                    elif args_str[i] == ')':
                        depth -= 1
                        if depth == 0:
                            tuple_str = args_str[val_start:i + 1]
                            result[key] = re.findall(r'"([^"]*)"', tuple_str)
                            pos = i + 1
                            break
                    i += 1
                else:
                    pos = val_start + 1
            else:
                pos = val_start + 1

        return result

    # 1. 从 HERMES_OVERLAYS 获取 provider 信息
    if providers_py.exists():
        content = providers_py.read_text(encoding="utf-8")
        # 找到 HERMES_OVERLAYS dict 的起止位置（括号匹配）
        dict_start = content.find("HERMES_OVERLAYS")
        if dict_start >= 0:
            brace_pos = content.find("{", dict_start)
            if brace_pos >= 0:
                depth = 0
                dict_end = brace_pos
                for i in range(brace_pos, len(content)):
                    if content[i] == '{':
                        depth += 1
                    elif content[i] == '}':
                        depth -= 1
                        if depth == 0:
                            dict_end = i
                            break
                dict_text = content[brace_pos:dict_end + 1]

                # 逐个提取 provider 定义
                for m in re.finditer(r'"([a-z][a-z0-9_-]+)"\s*:\s*HermesOverlay\s*\(', dict_text):
                    provider_id = m.group(1)
                    paren_start = m.end() - 1  # '(' 的位置
                    args_str = _extract_overlay_args(dict_text, paren_start)
                    if not args_str:
                        continue
                    overlay_data = _parse_overlay_args(args_str)
                    presets[provider_id] = {
                        "id": provider_id,
                        "name": provider_id,
                        "base_url": overlay_data.get("base_url_override", ""),
                        "base_url_env_var": overlay_data.get("base_url_env_var", ""),
                        "transport": overlay_data.get("transport", "openai_chat"),
                        "auth_type": overlay_data.get("auth_type", "api_key"),
                        "extra_env_vars": overlay_data.get("extra_env_vars", []),
                    }

    # 2. 从 _URL_TO_PROVIDER 补充 base_url
    if model_metadata_py.exists():
        content = model_metadata_py.read_text(encoding="utf-8")
        m = re.search(r"^_URL_TO_PROVIDER:\s*Dict\[str,\s*str\]\s*=\s*(\{.*?^\})", content, re.MULTILINE | re.DOTALL)
        if m:
            try:
                url_to_provider = ast.literal_eval(m.group(1))
                provider_urls: dict[str, str] = {}
                for url, prov in url_to_provider.items():
                    if prov not in provider_urls and not url.startswith("."):
                        if url in ("portal.qwen.ai", "chatgpt.com"):
                            continue
                        if url == "openrouter.ai":
                            provider_urls[prov] = f"https://{url}/api/v1"
                        else:
                            provider_urls[prov] = f"https://{url}/v1"

                for prov_id, base_url in provider_urls.items():
                    if prov_id in presets:
                        if not presets[prov_id].get("base_url"):
                            presets[prov_id]["base_url"] = base_url
                    else:
                        presets[prov_id] = {
                            "id": prov_id,
                            "name": prov_id,
                            "base_url": base_url,
                            "base_url_env_var": "",
                            "transport": "openai_chat",
                            "auth_type": "api_key",
                            "extra_env_vars": [],
                        }
            except Exception:
                pass

    # 3. 推断 key_env：优先 extra_env_vars[0]，其次 models.dev env[0]，最后 PROVIDER_API_KEY
    #    同时从 models.dev 缓存获取 env vars 作为补充
    _MODELS_DEV_ENV: dict[str, list[str]] = {}
    try:
        import json as _json
        hermes_home_path = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
        cache_path = hermes_home_path / "models_dev_cache.json"
        if cache_path.exists():
            cache_data = _json.loads(cache_path.read_text(encoding="utf-8"))
            providers_data = cache_data.get("providers", {})
            # PROVIDER_TO_MODELS_DEV 映射
            _P2MD = {
                "openrouter": "openrouter", "anthropic": "anthropic", "openai": "openai",
                "deepseek": "deepseek", "alibaba": "alibaba", "zai": "zai",
                "xai": "xai", "groq": "groq", "google": "google", "nvidia": "nvidia",
                "minimax": "minimax", "minimax-cn": "minimax-cn", "stepfun": "stepfun",
                "fireworks": "fireworks-ai", "novita": "novita-ai", "mistral": "mistral",
                "togetherai": "togetherai", "perplexity": "perplexity", "cohere": "cohere",
                "huggingface": "huggingface", "xiaomi": "xiaomi", "ollama-cloud": "ollama-cloud",
                "nous": "nousresearch",
            }
            for prov_id in presets:
                mdev_id = _P2MD.get(prov_id, prov_id)
                mdev_prov = providers_data.get(mdev_id, {})
                env_vars = mdev_prov.get("env", [])
                if env_vars:
                    _MODELS_DEV_ENV[prov_id] = env_vars
    except Exception:
        pass

    for prov_id, preset in presets.items():
        extra_envs = preset.get("extra_env_vars", [])
        if extra_envs and isinstance(extra_envs, list) and extra_envs[0]:
            preset["key_env"] = extra_envs[0]
        elif prov_id in _MODELS_DEV_ENV and _MODELS_DEV_ENV[prov_id]:
            preset["key_env"] = _MODELS_DEV_ENV[prov_id][0]
        else:
            preset["key_env"] = f"{prov_id.upper().replace('-', '_')}_API_KEY"

    # 4. 过滤掉不适合用户配置的 provider
    SKIP_PROVIDERS = {"moa", "copilot-acp", "local", "bedrock"}
    result = [p for p in presets.values() if p["id"] not in SKIP_PROVIDERS]

    # 排序：常用 provider 在前
    PRIORITY = {"openrouter", "deepseek", "anthropic", "openai", "google", "xai", "groq", "alibaba", "zai"}
    result.sort(key=lambda p: (0 if p["id"] in PRIORITY else 1, p["id"]))

    return result


@router.get("/provider-presets")
def get_provider_presets(
    user: User = Depends(get_current_user),
):
    """返回 Hermes 内置的 provider 预设列表"""
    return {"presets": _load_provider_presets()}


class ProviderModelsResult(BaseModel):
    name: str
    base_url: str
    key_env: str
    has_key: bool
    api_mode: str = ""
    status_code: int | None = None
    models: list[str] = []
    error: str | None = None


@router.get("/providers/{name}/models", response_model=ProviderModelsResult)
def get_provider_models(
    name: str,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    yaml_svc: YamlService = Depends(yaml_service),
):
    profile_name = ensure_profile_access(user, profile)
    config = yaml_svc.read_config(profile_name)
    env_svc = EnvService(yaml_svc.profiles.hermes_home)
    env_vars = env_svc.read_env(profile_name)

    providers = _collect_providers_from_config_and_env(config, env_vars)
    provider = next((p for p in providers if str(p.get("name", "")).lower() == name.lower()), None)
    if not provider:
        raise HTTPException(status_code=404, detail=f"Provider '{name}' not found")

    # 优先使用 config.yaml 中 custom_providers[].models 的显式模型列表
    configured_models: list[str] = []
    if isinstance(config, dict):
        cp_list = config.get("custom_providers", [])
        if isinstance(cp_list, list):
            for cp in cp_list:
                if not isinstance(cp, dict):
                    continue
                if str(cp.get("name", "")).lower() != str(provider.get("name", "")).lower():
                    continue
                raw_models = cp.get("models")
                if isinstance(raw_models, dict):
                    configured_models = [str(k) for k in raw_models.keys() if k]
                elif isinstance(raw_models, list):
                    configured_models = [str(item) for item in raw_models if item]
                break

    if configured_models:
        return ProviderModelsResult(
            name=str(provider.get("name", name)),
            base_url=str(provider.get("base_url") or ""),
            key_env=str(provider.get("key_env", "")),
            has_key=bool(provider.get("has_key")),
            api_mode=str(provider.get("api_mode") or ""),
            status_code=200,
            models=sorted(set(configured_models)),
        )

    base_url = str(provider.get("base_url") or "").rstrip("/")
    if not base_url:
        return ProviderModelsResult(
            name=str(provider.get("name", name)),
            base_url="",
            key_env=str(provider.get("key_env", "")),
            has_key=bool(provider.get("has_key")),
            api_mode=str(provider.get("api_mode") or ""),
            error="未配置 Base URL",
        )

    # 解析 key：优先 key_env，再 fallback PROVIDER_API_KEY
    key_env = str(provider.get("key_env", ""))
    api_key = env_vars.get(key_env, "") if key_env else ""
    if not api_key:
        fallback_key = f"{str(provider.get('name', name)).upper()}_API_KEY"
        api_key = env_vars.get(fallback_key, "")

    # 自定义 provider 的 inline key fallback
    if not api_key and isinstance(config, dict):
        cp_list = config.get("custom_providers", [])
        if isinstance(cp_list, list):
            for cp in cp_list:
                if isinstance(cp, dict) and str(cp.get("name", "")).lower() == str(provider.get("name", "")).lower():
                    api_key = str(cp.get("api_key") or "")
                    break

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    proxies = {
        "http": "http://10.0.0.10:9132",
        "https": "http://10.0.0.10:9132",
    }

    import requests as req_lib
    from requests.exceptions import RequestException

    models_url = f"{base_url}/models"
    try:
        resp = req_lib.get(models_url, headers=headers, proxies=proxies, timeout=15)
        if resp.status_code != 200:
            return ProviderModelsResult(
                name=str(provider.get("name", name)),
                base_url=base_url,
                key_env=key_env,
                has_key=bool(api_key),
                api_mode=str(provider.get("api_mode") or ""),
                status_code=resp.status_code,
                error=f"HTTP {resp.status_code}: {resp.text[:300]}",
            )

        payload = resp.json() if resp.text else {}
        raw_models = []
        if isinstance(payload, dict):
            raw_models = payload.get("data") or payload.get("models") or []

        models: list[str] = []
        if isinstance(raw_models, list):
            for item in raw_models:
                if isinstance(item, dict):
                    mid = item.get("id")
                    if mid:
                        models.append(str(mid))
                else:
                    models.append(str(item))

        return ProviderModelsResult(
            name=str(provider.get("name", name)),
            base_url=base_url,
            key_env=key_env,
            has_key=bool(api_key),
            api_mode=str(provider.get("api_mode") or ""),
            status_code=resp.status_code,
            models=models[:200],
        )
    except RequestException as exc:
        return ProviderModelsResult(
            name=str(provider.get("name", name)),
            base_url=base_url,
            key_env=key_env,
            has_key=bool(api_key),
            api_mode=str(provider.get("api_mode") or ""),
            status_code=0,
            error=f"请求失败: {str(exc)}",
        )


# ── 自定义 Provider 连通性测试 ─────────────────────────────────


class TestConnectionRequest(BaseModel):
    name: str
    model: str | None = None


class TestConnectionResult(BaseModel):
    name: str
    base_url: str
    models_endpoint: dict[str, Any] | None = None
    models_error: str | None = None
    chat_test: dict[str, Any] | None = None
    chat_error: str | None = None
    http_code: int | None = None
    provider_info: dict[str, Any] | None = None


@router.post("/custom_providers/test-connection", response_model=TestConnectionResult)
def test_custom_provider_connection(
    body: TestConnectionRequest,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    yaml_svc: YamlService = Depends(yaml_service),
):
    """
    测试自定义 Provider 的连通性：
    1. 调用 /v1/models 获取该 provider 支持的模型列表
    2. 如果指定了 model，额外调用 /v1/chat/completions 验证模型响应
    """
    profile_name = ensure_profile_access(user, profile)

    # 读取 custom_providers 配置
    config = yaml_svc.read_config(profile_name)
    custom_providers = config.get("custom_providers", [])
    if not isinstance(custom_providers, list):
        raise HTTPException(status_code=500, detail="Invalid custom_providers config")

    provider = None
    for p in custom_providers:
        if isinstance(p, dict) and p.get("name") == body.name:
            provider = p
            break

    if not provider:
        raise HTTPException(status_code=404, detail=f"Provider '{body.name}' not found")

    base_url = provider.get("base_url", "").rstrip("/")
    if not base_url:
        raise HTTPException(status_code=400, detail=f"Provider '{body.name}' has no base_url configured")

    # 获取 API key
    env_svc = EnvService(yaml_svc.profiles.hermes_home)
    env_vars = env_svc.read_env(profile_name)

    api_key = ""
    key_env = provider.get("key_env", "")
    if key_env:
        api_key = env_vars.get(key_env, "")
    else:
        # fallback: 使用 provider 的 api_key 字段（如果直接配置了值）
        api_key = provider.get("api_key", "") or ""

    # 构建 headers
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    # 代理配置 (NAS 环境)
    proxies = {
        "http": "http://10.0.0.10:9132",
        "https": "http://10.0.0.10:9132",
    }

    import requests as req_lib
    from requests.exceptions import RequestException

    # 结果容器
    result = TestConnectionResult(
        name=body.name,
        base_url=base_url,
        provider_info={
            "name": body.name,
            "base_url": base_url,
            "key_env": key_env or "(inline)",
            "has_key": bool(api_key),
        },
    )

    # ── 1. 测试 /v1/models ──
    models_url = f"{base_url}/models"
    try:
        resp = req_lib.get(
            models_url,
            headers=headers,
            proxies=proxies,
            timeout=15,
        )
        result.http_code = resp.status_code
        if resp.status_code == 200:
            data = resp.json()
            models_list = []
            if isinstance(data, dict):
                raw = data.get("data") or data.get("models") or []
                if isinstance(raw, list):
                    models_list = [
                        {"id": m.get("id", str(m)) if isinstance(m, dict) else str(m),
                         "object": m.get("object") if isinstance(m, dict) else None,
                         "owned_by": m.get("owned_by") if isinstance(m, dict) else None}
                        for m in raw
                    ]
            result.models_endpoint = {
                "url": models_url,
                "status_code": resp.status_code,
                "total": len(models_list),
                "models": models_list[:50],
                "latency_ms": resp.elapsed.total_seconds() * 1000 if hasattr(resp, "elapsed") else None,
            }
        else:
            result.models_error = f"HTTP {resp.status_code}: {resp.text[:500]}"
    except RequestException as e:
        result.models_error = f"请求失败: {str(e)}"
        result.http_code = 0

    # ── 2. 如果指定了 model，测试 /v1/chat/completions ──
    if body.model:
        chat_url = f"{base_url}/chat/completions"
        chat_payload = {
            "model": body.model,
            "messages": [{"role": "user", "content": "Respond with exactly: OK"}],
            "max_tokens": 10,
            "temperature": 0,
        }
        try:
            chat_resp = req_lib.post(
                chat_url,
                headers=headers,
                json=chat_payload,
                proxies=proxies,
                timeout=30,
            )
            if chat_resp.status_code == 200:
                chat_data = chat_resp.json()
                choice = chat_data.get("choices", [{}])[0]
                content = choice.get("message", {}).get("content", "") if isinstance(choice, dict) else ""
                result.chat_test = {
                    "model": body.model,
                    "status_code": chat_resp.status_code,
                    "response": content[:200],
                    "latency_ms": chat_resp.elapsed.total_seconds() * 1000 if hasattr(chat_resp, "elapsed") else None,
                    "usage": chat_data.get("usage"),
                }
            else:
                result.chat_error = f"HTTP {chat_resp.status_code}: {chat_resp.text[:500]}"
        except RequestException as e:
            result.chat_error = f"请求失败: {str(e)}"

    return result
