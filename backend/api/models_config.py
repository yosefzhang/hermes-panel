from __future__ import annotations

import json
from pathlib import Path
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


def _registry_path() -> Path:
    """Locate hermes_provider_registry.json relative to the project root."""
    return Path(__file__).resolve().parent.parent.parent / "hermes_provider_registry.json"


def _load_provider_registry() -> dict[str, dict[str, Any]]:
    """Load the provider registry (env var → provider metadata).

    Data source: hermes_provider_registry.json at the project root. The file is
    a flat mapping of the form:

        { "providers": { "DEEPSEEK_API_KEY": { "name": "DeepSeek", "base_url": "..." }, ... } }

    The key is the authoritative env var: if it has a value in the profile's
    .env, the corresponding provider is considered configured. The registry
    intentionally does NOT include the "costme" provider.
    """
    path = _registry_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    providers = data.get("providers", {}) if isinstance(data, dict) else {}
    if not isinstance(providers, dict):
        return {}
    return {
        str(env_key): {
            "name": str(info.get("name") or env_key),
            "base_url": str(info.get("base_url") or ""),
            "base_url_env_var": str(info.get("base_url_env_var") or ""),
        }
        for env_key, info in providers.items()
        if isinstance(info, dict) and (info.get("name") or info.get("base_url"))
    }


def _load_hermes_provider_base_urls() -> dict[str, str]:
    """Return provider name → default base URL from the provider registry.

    Deduplicates multiple env vars that map to the same provider name (e.g.
    ANTHROPIC_API_KEY / ANTHROPIC_TOKEN both map to "Anthropic").
    """
    result: dict[str, str] = {}
    for info in _load_provider_registry().values():
        name = info.get("name", "")
        url = str(info.get("base_url") or "").strip()
        if name and url:
            result[name] = url
    return result


def _collect_providers_from_config_and_env(
    config: dict[str, Any], env_vars: dict[str, str]
) -> list[dict[str, Any]]:
    """合并 config + .env 中的所有 provider，返回统一列表。"""
    registry = _load_provider_registry()
    # provider name → 默认 base_url（同一 provider 多个 env var 去重）
    name_to_base_url: dict[str, str] = {}
    for info in registry.values():
        name = info.get("name", "")
        url = str(info.get("base_url") or "").strip()
        if name and url and name not in name_to_base_url:
            name_to_base_url[name] = url

    # 1. 主 provider（来自 model 区段）
    model_section = config.get("model", {}) if isinstance(config, dict) else {}
    main_provider_name = (model_section.get("provider", "") if isinstance(model_section, dict) else "").replace("custom:", "")
    main_base_url = model_section.get("base_url", "") if isinstance(model_section, dict) else ""

    # 2. 自定义 provider
    custom_list = config.get("custom_providers", []) if isinstance(config, dict) else []
    if not isinstance(custom_list, list):
        custom_list = []

    # 3. 从 .env 中按 registry 反查已配置的 provider：
    #    遍历 .env 的环境变量，若某个变量是 registry 的 key，则该 provider 已配置。
    env_providers: dict[str, dict[str, Any]] = {}
    for env_key, env_val in env_vars.items():
        if not env_val:
            continue
        info = registry.get(env_key)
        if not info:
            continue
        name = info.get("name", env_key)
        # 同一 provider 名只保留第一个匹配的 env var
        if name not in env_providers:
            # base_url：优先取 base_url_env_var 在 .env 中的值（用户可能自定义 URL），
            # 否则回退 registry 中的默认 base_url。
            base_url = ""
            base_url_env_var = str(info.get("base_url_env_var") or "")
            if base_url_env_var and env_vars.get(base_url_env_var):
                base_url = env_vars[base_url_env_var]
            if not base_url:
                base_url = str(info.get("base_url") or "")
            env_providers[name] = {**info, "key_env": env_key, "base_url": base_url}

    # 构建结果 — custom_providers 是 provider 列表，model.provider 标记当前激活
    seen: set[str] = set()
    result: list[dict[str, Any]] = []

    # Resolve the active provider name from model.provider
    active_provider_name = main_provider_name
    # When model.provider == "custom", match by base_url to find the actual custom_providers entry
    if active_provider_name == "custom" and main_base_url:
        for cp in custom_list:
            if isinstance(cp, dict) and str(cp.get("base_url", "")).rstrip("/") == main_base_url.rstrip("/"):
                active_provider_name = str(cp.get("name", "custom"))
                break

    # 自定义 provider（来自 custom_providers）
    for cp in custom_list:
        if not isinstance(cp, dict):
            continue
        cname = cp.get("name", "")
        if not cname or cname in seen:
            continue
        seen.add(cname)
        key_env = cp.get("key_env", "") or ""
        is_active = (cname == active_provider_name)
        result.append({
            "name": cname,
            "source": "custom",
            "base_url": cp.get("base_url", "") or "",
            "api_mode": str(cp.get("api_mode") or ""),
            "key_env": key_env,
            "api_key": cp.get("api_key", "") or "",
            "default_model": str(cp.get("default_model") or cp.get("model") or ""),
            "context_length": cp.get("context_length"),
            "rate_limit_delay": cp.get("rate_limit_delay"),
            "has_key": bool(env_vars.get(key_env)) if key_env else bool(cp.get("api_key")),
            "is_active": is_active,
        })

    # 仅 .env 中发现的 provider（来自 registry；无 base_url 的也展示，由前端显示为默认地址）
    for name, info in sorted(env_providers.items()):
        if name in seen:
            continue
        seen.add(name)
        base_url = str(info.get("base_url") or "") or name_to_base_url.get(name, "")
        result.append({
            "name": name,
            "display_name": name,
            "source": "env",
            "base_url": base_url,
            "base_url_env_var": str(info.get("base_url_env_var") or ""),
            "api_mode": "",
            "key_env": info.get("key_env", ""),
            "has_key": True,
            "is_active": (name == active_provider_name),
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


# ── Provider 预设列表（来自 hermes_provider_registry.json）─────────────────────


def _load_provider_presets() -> list[dict[str, Any]]:
    """
    从 hermes_provider_registry.json 加载内置 provider 预设列表。

    数据源与 env provider 扫描一致，确保"新增 Provider"下拉里的预设
    与 .env 中自动识别出的 provider 完全对应。registry 不包含 costme。
    """
    presets: dict[str, dict[str, Any]] = {}
    # registry: env_var → {name, base_url, base_url_env_var}；同一 name 的多个 env var 归并为一条预设
    for env_key, info in _load_provider_registry().items():
        name = info.get("name", "")
        if not name:
            continue
        if name not in presets:
            presets[name] = {
                "id": name,
                "name": name,
                "base_url": str(info.get("base_url") or ""),
                "base_url_env_var": str(info.get("base_url_env_var") or ""),
                "transport": "openai_chat",
                "auth_type": "api_key",
                "extra_env_vars": [],
                "key_env": env_key,
            }
        else:
            env_vars = presets[name].get("extra_env_vars") or []
            if env_key not in env_vars:
                env_vars.append(env_key)
            presets[name]["extra_env_vars"] = env_vars

    result = list(presets.values())

    # 排序：常用 provider 在前
    PRIORITY = {"deepseek", "anthropic", "OpenAI API", "Google AI Studio", "xAI", "GitHub Copilot", "Qwen Cloud", "Z.AI / GLM"}
    result.sort(key=lambda p: (0 if p["name"] in PRIORITY else 1, p["name"]))

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
    models: list[dict[str, Any]] = []
    error: str | None = None


_MULTIMODAL_KEYWORDS = ("vision", "vl", "multimodal", "audio", "tts", "embedding-vision", "image", "whisper")


def _is_multimodal(item: Any, mid: str) -> bool:
    if isinstance(item, dict):
        for key in ("multimodal", "supports_multimodal", "vision"):
            val = item.get(key)
            if isinstance(val, bool):
                return val
    mid_lower = mid.lower()
    return any(kw in mid_lower for kw in _MULTIMODAL_KEYWORDS)


def _normalize_model_item(item: Any) -> dict[str, Any]:
    """把 /models 返回的单个模型条目规整为统一结构。

    兼容两种形态：
    - dict：取 id / name / owned_by / context_length / created 等字段
    - 其它（字符串等）：仅作为 id
    """
    if isinstance(item, dict):
        mid = item.get("id")
        if not mid:
            return {}
        mid_str = str(mid)
        output_length = (
            item.get("max_output_tokens")
            or item.get("output_length")
            or item.get("output_window")
        )
        return {
            "id": mid_str,
            "name": str(item.get("name") or item.get("owned_by") or mid),
            "owned_by": str(item.get("owned_by") or ""),
            "context_length": item.get("context_length"),
            "output_length": output_length,
            "created": item.get("created"),
            "multimodal": _is_multimodal(item, mid_str),
        }
    if item:
        mid_str = str(item)
        return {
            "id": mid_str,
            "name": mid_str,
            "owned_by": "",
            "context_length": None,
            "output_length": None,
            "created": None,
            "multimodal": _is_multimodal(None, mid_str),
        }
    return {}


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
            models=[_normalize_model_item(m) for m in sorted(set(configured_models))],
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

    import os as _os
    proxies = None
    _http_proxy = _os.environ.get("HTTP_PROXY") or _os.environ.get("http_proxy")
    _https_proxy = _os.environ.get("HTTPS_PROXY") or _os.environ.get("https_proxy")
    if _http_proxy or _https_proxy:
        proxies = {"http": _http_proxy, "https": _https_proxy}

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

        models: list[dict[str, Any]] = []
        if isinstance(raw_models, list):
            for item in raw_models:
                normalized = _normalize_model_item(item)
                if normalized:
                    models.append(normalized)

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

    import os as _os
    proxies = None
    _http_proxy = _os.environ.get("HTTP_PROXY") or _os.environ.get("http_proxy")
    _https_proxy = _os.environ.get("HTTPS_PROXY") or _os.environ.get("https_proxy")
    if _http_proxy or _https_proxy:
        proxies = {"http": _http_proxy, "https": _https_proxy}

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


class ProviderCreatePayload(BaseModel):
    """新增 provider 的请求体。

    mode="preset"：从 hermes_provider_registry.json 反查预设，只需 provider_name 与 key_value；
    mode="custom"：完全自定义，需 name / key_env_var / key_value / base_url，其余可选。
    """
    mode: str = "preset"  # "preset" | "custom"
    provider_name: str = ""
    name: str = ""
    key_env_var: str = ""
    key_value: str = ""
    base_url: str = ""
    api_mode: str | None = None
    default_model: str | None = None
    context_length: int | None = None
    rate_limit_delay: float | None = None


@router.post("/providers", status_code=201)
def create_provider(
    payload: ProviderCreatePayload,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    yaml_svc: YamlService = Depends(yaml_service),
):
    """新增 provider：把 key 写入 .env，把 provider 配置写入 config.yaml。

    preset 模式：从 provider registry 反查预设，key_env / base_url 固定取自 registry，
    仅需用户提供 key 值。
    custom 模式：完全由用户提供 name / key_env_var / key_value / base_url 等。
    """
    profile_name = ensure_profile_access(user, profile)
    env_svc = EnvService(yaml_svc.profiles.hermes_home)

    if payload.mode == "preset":
        provider_name = payload.provider_name.strip()
        if not provider_name:
            raise HTTPException(status_code=400, detail="请选择要新增的 Provider 预设")
        lookup = _registry_lookup_by_name(provider_name)
        if not lookup:
            raise HTTPException(status_code=404, detail=f"Provider 预设 '{provider_name}' 不存在")
        env_key, prov = lookup
        if payload.key_env_var.strip():
            env_key = payload.key_env_var.strip()
        if not env_key:
            raise HTTPException(status_code=400, detail=f"Provider '{provider_name}' 没有可写入的 key 环境变量")
        base_url = payload.base_url.strip() or str(prov.get("base_url") or "")
        entry_name = payload.name.strip() or str(prov.get("name") or provider_name)
        entry: dict[str, Any] = {
            "name": entry_name,
            "base_url": base_url,
            "key_env": env_key,
        }
        if payload.default_model:
            entry["default_model"] = payload.default_model.strip()
        if payload.api_mode:
            entry["api_mode"] = payload.api_mode.strip()
        if payload.context_length is not None:
            entry["context_length"] = payload.context_length
        if payload.rate_limit_delay is not None:
            entry["rate_limit_delay"] = payload.rate_limit_delay
    else:
        entry_name = payload.name.strip()
        env_key = payload.key_env_var.strip()
        base_url = payload.base_url.strip()
        if not entry_name:
            raise HTTPException(status_code=400, detail="name 不能为空")
        if not env_key:
            raise HTTPException(status_code=400, detail="key_env_var 不能为空")
        if not base_url:
            raise HTTPException(status_code=400, detail="base_url 不能为空")
        entry = {
            "name": entry_name,
            "base_url": base_url,
            "key_env": env_key,
        }
        if payload.default_model:
            entry["default_model"] = payload.default_model.strip()
        if payload.api_mode:
            entry["api_mode"] = payload.api_mode.strip()
        if payload.context_length is not None:
            entry["context_length"] = payload.context_length
        if payload.rate_limit_delay is not None:
            entry["rate_limit_delay"] = payload.rate_limit_delay

    # 1) 写入 .env：key_env_var=key_value
    if payload.key_value:
        env_svc.set_env_var(profile_name, env_key, payload.key_value)

    # 2) 写入 config.yaml：custom_providers 追加（同名去重）
    config = yaml_svc.read_config(profile_name)
    custom_list = config.get("custom_providers", [])
    if not isinstance(custom_list, list):
        custom_list = []
    next_list = [
        item for item in custom_list
        if not (isinstance(item, dict) and str(item.get("name", "")).lower() == entry_name.lower())
    ]
    next_list.append(entry)
    yaml_svc.write_section(profile_name, "custom_providers", next_list)

    return {"ok": True, "mode": payload.mode, "name": entry_name, "key_env": env_key}


def _registry_lookup_by_name(provider_name: str) -> tuple[str, dict[str, Any]] | None:
    """按预设名从 provider registry 反查 (env_key, provider_meta)。

    registry 结构为 ``env_var → {name, base_url, base_url_env_var}``，
    因此通过 name 反查时把 env var 名一并带回，供 preset 模式写 .env 使用。
    同一 name 可能有多个 env var（如 Anthropic 三个），优先返回第一个。
    """
    target = provider_name.strip().lower()
    for env_key, info in _load_provider_registry().items():
        if str(info.get("name") or "").lower() == target:
            return env_key, info
    return None
