"""Hermes 文件与配置相关的 API 路由。

涵盖 config.yaml / .env / 记忆文件、profile 发现、渠道、skills、
模型与 provider 配置，以及跨 profile 的批量管理。
"""
from __future__ import annotations

import json
import logging
import re
import shutil
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from backend.auth import (
    ensure_profile_access,
    get_accessible_profiles,
    get_current_user,
    require_admin,
)
from backend.config import get_settings
from backend.services.profile import (
    EnvService,
    ProfileService,
    SkillService,
    YamlService,
    atomic_write_text,
)
from backend.services.system import log_audit_event
from backend.store import User

logger = logging.getLogger(__name__)


# ── 共享依赖 ────────────────────────────────────────────────────────────────


def yaml_service(request: Request) -> YamlService:
    return YamlService(request.app.state.settings.hermes_home)


def profile_service(request: Request) -> ProfileService:
    return ProfileService(request.app.state.settings.hermes_home)


def skill_service(request: Request) -> SkillService:
    return SkillService()


# ── /config ────────────────────────────────────────────────────────────────

config_router = APIRouter(prefix="/config", tags=["config"])


class RawConfigUpdate(BaseModel):
    content: str


class SectionUpdate(BaseModel):
    section: str
    payload: dict[str, Any]


@config_router.get("")
async def get_config(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    profile_name = ensure_profile_access(user, profile)
    return service.read_config(profile_name)


@config_router.get("/sections")
async def list_sections(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    profile_name = ensure_profile_access(user, profile)
    return {"sections": service.list_sections(profile_name)}


@config_router.get("/sections/{name}")
async def get_section(
    name: str,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    profile_name = ensure_profile_access(user, profile)
    return service.read_section(profile_name, name)


@config_router.put("/sections/{name}")
async def update_section(
    name: str,
    payload: dict[str, Any],
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    profile_name = ensure_profile_access(user, profile)
    service.write_section(profile_name, name, payload)
    return {"ok": True, "section": name}


@config_router.get("/raw")
async def get_raw_config(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    profile_name = ensure_profile_access(user, profile)
    return {"content": service.read_raw(profile_name)}


@config_router.put("/raw")
async def update_raw_config(
    payload: RawConfigUpdate,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    profile_name = ensure_profile_access(user, profile)
    service.write_raw(profile_name, payload.content)
    return {"ok": True}


# ── /profile-files ──────────────────────────────────────────────────────────

profile_files_router = APIRouter(prefix="/profile-files", tags=["profile-files"])

_SECRET_KEY_HINT = re.compile(r"(KEY|SECRET|TOKEN|PASSWORD|PASSWD|API)", re.IGNORECASE)
_MASK_KEEP = 3


class ProfileFile(BaseModel):
    name: str
    path: str
    exists: bool
    masked: bool = False
    content: str = ""


class ProfileFileUpdate(BaseModel):
    name: str
    content: str


_EDITABLE_FILES = {"SOUL.md", "soul.md", "USER.md", "MEMORY.md"}


def _file_path(profile_root: Path, name: str) -> Path | None:
    if name in ("SOUL.md", "soul.md"):
        return _resolve_soul_path(profile_root)
    if name in ("USER.md", "MEMORY.md"):
        return profile_root / "memories" / name
    return None


def _mask_value(value: str) -> str:
    if not value:
        return value
    if len(value) <= _MASK_KEEP * 2:
        return "***"
    return f"{value[:_MASK_KEEP]}***{value[-_MASK_KEEP:]}"


def _mask_env_content(content: str) -> str:
    if not content:
        return content
    trailing_newline = "\n" if content.endswith("\n") else ""
    out: list[str] = []
    for line in content.splitlines():
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            out.append(line)
            continue
        key, _, value = line.partition("=")
        if _SECRET_KEY_HINT.search(key.strip()):
            out.append(f"{key}={_mask_value(value.strip())}")
        else:
            out.append(line)
    return "\n".join(out) + trailing_newline


def _resolve_soul_path(profile_root: Path) -> Path:
    """Return the path to the SOUL file, preferring the canonical casing."""
    for name in ("SOUL.md", "soul.md"):
        path = profile_root / name
        if path.exists():
            return path
    return profile_root / "SOUL.md"


def _build_file_list(profile_root: Path) -> list[ProfileFile]:
    soul_path = _resolve_soul_path(profile_root)
    candidates: list[tuple[str, Path, bool]] = [
        ("config.yaml", profile_root / "config.yaml", False),
        (".env", profile_root / ".env", True),
        (soul_path.name, soul_path, False),
        ("USER.md", profile_root / "memories" / "USER.md", False),
        ("MEMORY.md", profile_root / "memories" / "MEMORY.md", False),
    ]
    files: list[ProfileFile] = []
    for name, path, masked in candidates:
        entry = ProfileFile(name=name, path=str(path), exists=path.exists(), masked=masked)
        if entry.exists:
            entry.content = path.read_text(encoding="utf-8")
            if masked:
                entry.content = _mask_env_content(entry.content)
        files.append(entry)
    return files


@profile_files_router.get("")
def get_profile_files(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    profiles: ProfileService = Depends(profile_service),
):
    ensure_profile_access(user, profile)
    root = profiles.profile_root(profile)
    return {"files": _build_file_list(root)}


@profile_files_router.put("")
def update_profile_file(
    payload: ProfileFileUpdate,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    profiles: ProfileService = Depends(profile_service),
):
    ensure_profile_access(user, profile)
    if payload.name not in _EDITABLE_FILES:
        raise HTTPException(status_code=400, detail=f"File '{payload.name}' is not editable")
    root = profiles.profile_root(profile)
    path = _file_path(root, payload.name)
    if path is None:
        raise HTTPException(status_code=400, detail=f"Unknown file '{payload.name}'")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload.content, encoding="utf-8")
    return {"ok": True, "name": payload.name}


# ── /profiles ───────────────────────────────────────────────────────────────

profiles_router = APIRouter(prefix="/profiles", tags=["profiles"])


class ProfileInfoResponse(BaseModel):
    name: str
    config_path: str
    env_path: str
    state_db_path: str
    skills_path: str
    exists: bool


@profiles_router.get("")
async def list_profiles(
    user: User = Depends(get_current_user),
    service: ProfileService = Depends(profile_service),
):
    profiles = service.list_profiles()
    if user.role != "admin" and "*" not in user.profiles:
        profiles = [profile for profile in profiles if profile in user.profiles]
    return {"profiles": profiles}


@profiles_router.get("/{name}", response_model=ProfileInfoResponse)
async def get_profile(
    name: str,
    user: User = Depends(get_current_user),
    service: ProfileService = Depends(profile_service),
):
    if user.role != "admin" and "*" not in user.profiles and name not in user.profiles:
        raise HTTPException(status_code=403, detail="No access to this profile")
    info = service.get_profile_info(name)
    return ProfileInfoResponse(
        name=info.name,
        config_path=str(info.config_path),
        env_path=str(info.env_path),
        state_db_path=str(info.state_db_path),
        skills_path=str(info.skills_path),
        exists=info.exists,
    )


# ── /memory ─────────────────────────────────────────────────────────────────

memory_router = APIRouter(prefix="/memory", tags=["memory"])


@memory_router.get("")
def get_memory(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
    profiles: ProfileService = Depends(profile_service),
):
    profile_name = ensure_profile_access(user, profile)
    root = profiles.profile_root(profile_name)
    memories = {}
    for filename in ("MEMORY.md", "USER.md"):
        path = root / "memories" / filename
        if path.exists():
            content = path.read_text(encoding="utf-8")
            memories[filename.removesuffix(".md")] = content

    return {
        "config": service.read_section(profile_name, "memory"),
        "memories": memories,
    }


@memory_router.put("")
def update_memory(
    payload: dict[str, Any],
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    service.write_section(ensure_profile_access(user, profile), "memory", payload)
    return {"ok": True}


# ── /skills ─────────────────────────────────────────────────────────────────

skills_router = APIRouter(prefix="/skills", tags=["skills"])


@skills_router.get("")
def list_skills(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: SkillService = Depends(skill_service),
):
    resolved = ensure_profile_access(user, profile)
    return {"skills": service.list_skills(resolved)}


@skills_router.get("/{name}")
def get_skill(
    name: str,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: SkillService = Depends(skill_service),
):
    try:
        return service.read_skill(ensure_profile_access(user, profile), name)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Skill not found") from error


# ── /channels ───────────────────────────────────────────────────────────────

channels_router = APIRouter(prefix="/channels", tags=["channels"])

CHANNEL_NAMES = (
    "telegram",
    "discord",
    "slack",
    "mattermost",
    "matrix",
    "feishu",
    "weixin",
    "webhook",
    "whatsapp",
)
CHANNELS_IN_PLATFORMS = {"webhook"}

CHANNEL_ENV_MARKERS: dict[str, str] = {
    "feishu": "FEISHU_APP_ID",
    "weixin": "WEIXIN_ACCOUNT_ID",
    "telegram": "TELEGRAM_BOT_TOKEN",
    "discord": "DISCORD_BOT_TOKEN",
    "slack": "SLACK_BOT_TOKEN",
    "mattermost": "MATTERMOST_TOKEN",
    "matrix": "MATRIX_ACCESS_TOKEN",
}
CHANNEL_ENV_ALT_MARKERS: dict[str, list[str]] = {
    "weixin": ["WEIXIN_TOKEN"],
}

CHANNEL_ENV_FIELDS: dict[str, list[str]] = {
    "feishu": [
        "FEISHU_APP_ID",
        "FEISHU_APP_SECRET",
        "FEISHU_VERIFICATION_TOKEN",
        "FEISHU_ENCRYPT_KEY",
    ],
    "weixin": [
        "WEIXIN_ACCOUNT_ID",
        "WEIXIN_TOKEN",
        "WEIXIN_ENCODING_AES_KEY",
    ],
    "telegram": ["TELEGRAM_BOT_TOKEN"],
    "discord": ["DISCORD_BOT_TOKEN"],
    "slack": ["SLACK_BOT_TOKEN"],
    "mattermost": ["MATTERMOST_TOKEN", "MATTERMOST_URL"],
    "matrix": ["MATRIX_HOMESERVER", "MATRIX_ACCESS_TOKEN", "MATRIX_USER_ID"],
}

CHANNEL_CREDENTIAL_ENV_MAP: dict[str, dict[str, str]] = {
    "telegram": {"token": "TELEGRAM_BOT_TOKEN"},
    "discord": {"token": "DISCORD_BOT_TOKEN"},
    "slack": {"token": "SLACK_BOT_TOKEN"},
    "mattermost": {"token": "MATTERMOST_TOKEN"},
    "matrix": {
        "homeserver": "MATRIX_HOMESERVER",
        "access_token": "MATRIX_ACCESS_TOKEN",
    },
    "feishu": {
        "app_id": "FEISHU_APP_ID",
        "app_secret": "FEISHU_APP_SECRET",
        "verification_token": "FEISHU_VERIFICATION_TOKEN",
        "encrypt_key": "FEISHU_ENCRYPT_KEY",
    },
    "weixin": {
        "token": "WEIXIN_TOKEN",
        "encoding_aes_key": "WEIXIN_ENCODING_AES_KEY",
    },
}

CHANNEL_CREDENTIAL_FIELDS = {
    "token",
    "bot_token",
    "app_id",
    "app_secret",
    "verification_token",
    "encrypt_key",
    "appid",
    "appsecret",
    "access_token",
    "phone_number_id",
    "corp_id",
    "agent_id",
    "secret",
    "key",
}


def _read_env_vars_for_profile(profile: str | None, hermes_home: Path | None = None) -> dict[str, str]:
    svc = EnvService(hermes_home=hermes_home)
    return svc.read_env(profile)


def _detect_env_channels(profile: str | None, hermes_home: Path | None = None) -> set[str]:
    env = _read_env_vars_for_profile(profile, hermes_home)
    configured: set[str] = set()
    for name in CHANNEL_NAMES:
        marker = CHANNEL_ENV_MARKERS.get(name)
        if marker and marker in env:
            configured.add(name)
            continue
        for alt in CHANNEL_ENV_ALT_MARKERS.get(name, []):
            if alt in env:
                configured.add(name)
                break
    return configured


def _deep_merge_dict(base: dict[str, Any], updates: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in updates.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge_dict(result[key], value)
        else:
            result[key] = value
    return result


def _read_channel_from_config(config: dict[str, Any], name: str) -> dict[str, Any] | None:
    direct = config.get(name)
    platforms = config.get("platforms")
    platform_channel: dict[str, Any] | None = None
    if isinstance(platforms, dict):
        nested = platforms.get(name)
        if isinstance(nested, dict):
            platform_channel = nested

    if isinstance(direct, dict) or isinstance(platform_channel, dict):
        base: dict[str, Any] = direct if isinstance(direct, dict) else {}
        view = _deep_merge_dict(base, platform_channel if isinstance(platform_channel, dict) else {})
        if isinstance(platform_channel, dict):
            view["enabled"] = bool(platform_channel.get("enabled", True))
        else:
            view["enabled"] = False
        return view

    return None


def _has_non_empty_credential(value: Any, key: str | None = None) -> bool:
    if isinstance(value, dict):
        return any(_has_non_empty_credential(child_value, str(child_key)) for child_key, child_value in value.items())
    if isinstance(value, list):
        return any(_has_non_empty_credential(item) for item in value)
    if key and key.lower() in CHANNEL_CREDENTIAL_FIELDS:
        if isinstance(value, str):
            return bool(value.strip())
        return bool(value)
    return False


def _is_channel_configured(name: str, channel: dict[str, Any]) -> bool:
    if name == "webhook":
        if bool(channel.get("enabled")):
            return True
        extra = channel.get("extra")
        if isinstance(extra, dict):
            routes = extra.get("routes")
            if isinstance(routes, dict) and len(routes) > 0:
                return True
        if isinstance(channel.get("key"), str) and channel.get("key", "").strip():
            return True
        return False
    return _has_non_empty_credential(channel)


def _write_channel_to_config(config: dict[str, Any], name: str, payload: dict[str, Any]) -> None:
    if set(payload.keys()) == {"enabled"} and isinstance(payload.get("enabled"), bool):
        if not isinstance(config.get("platforms"), dict):
            config["platforms"] = {}
        platforms = config["platforms"]
        raw_current = platforms.get(name)
        current: dict[str, Any] = raw_current if isinstance(raw_current, dict) else {}
        current["enabled"] = bool(payload["enabled"])
        platforms[name] = current
        return

    if name in config and isinstance(config.get(name), dict):
        config[name] = _deep_merge_dict(config[name], payload)
        return

    platforms = config.get("platforms")
    if isinstance(platforms, dict) and name in platforms and isinstance(platforms.get(name), dict):
        platforms[name] = _deep_merge_dict(platforms[name], payload)
        return

    if name in CHANNELS_IN_PLATFORMS:
        if not isinstance(config.get("platforms"), dict):
            config["platforms"] = {}
        platforms = config["platforms"]
        raw_current = platforms.get(name)
        current: dict[str, Any] = raw_current if isinstance(raw_current, dict) else {}
        platforms[name] = _deep_merge_dict(current, payload)
        return

    raw_current = config.get(name)
    current: dict[str, Any] = raw_current if isinstance(raw_current, dict) else {}
    config[name] = _deep_merge_dict(current, payload)


@channels_router.get("")
def get_channels(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    safe_profile = ensure_profile_access(user, profile)
    config = service.read_config(safe_profile)
    if not isinstance(config, dict):
        config = {}

    result: dict[str, Any] = {}
    for name in CHANNEL_NAMES:
        channel = _read_channel_from_config(config, name)
        if isinstance(channel, dict) and _is_channel_configured(name, channel):
            result[name] = channel

    hermes_home = service.profiles.hermes_home
    env_channels = _detect_env_channels(safe_profile, hermes_home)
    for name in env_channels:
        if name not in result:
            result[name] = {
                "enabled": True,
                "configured_via": "env",
                "_note": "此渠道通过环境变量配置，无法在此编辑。请修改 .env 文件。",
            }

    return result


@channels_router.get("/env")
def get_channels_env(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    safe_profile = ensure_profile_access(user, profile)
    env_svc = EnvService(hermes_home=service.profiles.hermes_home)
    env_vars = env_svc.read_env(safe_profile)
    result: dict[str, dict[str, str]] = {}
    for name, fields in CHANNEL_ENV_FIELDS.items():
        found = {field: env_vars[field] for field in fields if field in env_vars}
        if found:
            result[name] = found
    return {"channels": result}


@channels_router.get("/{name}")
def get_channel(
    name: str,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    config = service.read_config(ensure_profile_access(user, profile))
    if not isinstance(config, dict):
        return {}
    channel = _read_channel_from_config(config, name)
    return channel if isinstance(channel, dict) else {}


@channels_router.put("/{name}")
def update_channel(
    name: str,
    payload: dict[str, Any],
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    safe_profile = ensure_profile_access(user, profile)

    config_payload: dict[str, Any] = dict(payload)
    env_updates: dict[str, str | None] = {}
    for field, env_var in CHANNEL_CREDENTIAL_ENV_MAP.get(name, {}).items():
        if field not in config_payload:
            continue
        value = config_payload.pop(field)
        env_updates[env_var] = value if (isinstance(value, str) and value.strip()) else None

    if env_updates:
        env_svc = EnvService(hermes_home=service.profiles.hermes_home)
        env_svc.write_env(safe_profile, env_updates)

    config = service.read_config(safe_profile)
    if not isinstance(config, dict):
        config = {}

    if config_payload:
        _write_channel_to_config(config, name, config_payload)
        service.write_config(safe_profile, config)
    return {"ok": True}


@channels_router.delete("/{name}")
def delete_channel(
    name: str,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    safe_profile = ensure_profile_access(user, profile)
    config = service.read_config(safe_profile)
    if not isinstance(config, dict):
        return {"ok": True}

    if name in config:
        del config[name]

    platforms = config.get("platforms")
    if isinstance(platforms, dict) and name in platforms:
        del platforms[name]

    service.write_config(safe_profile, config)
    return {"ok": True}


@channels_router.get("/{name}/env")
def get_channel_env(
    name: str,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    safe_profile = ensure_profile_access(user, profile)
    env_svc = EnvService(hermes_home=service.profiles.hermes_home)
    env_vars = env_svc.read_env(safe_profile)
    fields = CHANNEL_ENV_FIELDS.get(name, [])
    result: dict[str, str] = {}
    for field in fields:
        if field in env_vars:
            result[field] = env_vars[field]
    return {"channel": name, "fields": result}


@channels_router.put("/{name}/env")
def update_channel_env(
    name: str,
    payload: dict[str, Any],
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    safe_profile = ensure_profile_access(user, profile)
    env_svc = EnvService(hermes_home=service.profiles.hermes_home)
    env_svc.write_env(safe_profile, payload)
    return {"ok": True}


# ── /models ─────────────────────────────────────────────────────────────────

models_router = APIRouter(prefix="/models", tags=["models"])

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


@models_router.get("")
def get_models(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    config = service.read_config(ensure_profile_access(user, profile))
    if not isinstance(config, dict):
        return {"model": {}, "auxiliary": {}, "fallback_providers": []}

    result: dict[str, Any] = {}
    for section in MODEL_SECTIONS:
        result[section] = config.get(section, {} if section != "fallback_providers" else [])
    return result


@models_router.put("/{section}")
def update_model_section(
    section: str,
    payload: dict[str, Any] | list[Any],
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    if section not in MODEL_SECTIONS:
        raise HTTPException(status_code=400, detail=f"Invalid section: {section}")
    profile_name = ensure_profile_access(user, profile)
    if isinstance(payload, dict) and section == "model":
        config = service.read_config(profile_name)
        existing = config.get("model") if isinstance(config, dict) else None
        if not isinstance(existing, dict):
            existing = {}
        merged: dict[str, Any] = {**existing, **payload}
        provider_changed = str(existing.get("provider") or "") != str(payload.get("provider") or "")
        explicit_mode = "api_mode" in payload and bool(str(payload.get("api_mode") or "").strip())
        if "api_mode" in payload:
            mode = str(payload.get("api_mode") or "").strip()
            if mode:
                merged["api_mode"] = mode
            else:
                merged.pop("api_mode", None)
        if provider_changed and not explicit_mode:
            merged.pop("api_mode", None)
            merged.pop("api_key", None)
            merged.pop("api", None)
        service.write_section(profile_name, "model", merged)
        return {"ok": True, "section": section}
    service.write_section(profile_name, section, payload)
    return {"ok": True, "section": section}


@models_router.delete("/providers/{name}")
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


_REGISTRY_FILENAME = "hermes_provider_registry.json"


def _builtin_registry_path() -> Path:
    return Path(__file__).resolve().parent.parent / _REGISTRY_FILENAME


def _registry_path() -> Path:
    return Path(get_settings().data_dir) / _REGISTRY_FILENAME


def _ensure_registry_file() -> None:
    path = _registry_path()
    if path.is_file():
        return
    builtin = _builtin_registry_path()
    if not builtin.is_file():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(builtin.read_text(encoding="utf-8"), encoding="utf-8")


def _load_provider_registry() -> dict[str, dict[str, Any]]:
    _ensure_registry_file()
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
    registry = _load_provider_registry()
    name_to_base_url: dict[str, str] = {}
    for info in registry.values():
        name = info.get("name", "")
        url = str(info.get("base_url") or "").strip()
        if name and url and name not in name_to_base_url:
            name_to_base_url[name] = url

    model_section = config.get("model", {}) if isinstance(config, dict) else {}
    main_provider_name = (model_section.get("provider", "") if isinstance(model_section, dict) else "").replace("custom:", "")
    main_base_url = model_section.get("base_url", "") if isinstance(model_section, dict) else ""

    custom_list = config.get("custom_providers", []) if isinstance(config, dict) else []
    if not isinstance(custom_list, list):
        custom_list = []

    env_providers: dict[str, dict[str, Any]] = {}
    for env_key, env_val in env_vars.items():
        if not env_val:
            continue
        info = registry.get(env_key)
        if not info:
            continue
        name = info.get("name", env_key)
        if name not in env_providers:
            base_url = ""
            base_url_env_var = str(info.get("base_url_env_var") or "")
            if base_url_env_var and env_vars.get(base_url_env_var):
                base_url = env_vars[base_url_env_var]
            if not base_url:
                base_url = str(info.get("base_url") or "")
            env_providers[name] = {**info, "key_env": env_key, "base_url": base_url}

    seen: set[str] = set()
    result: list[dict[str, Any]] = []

    active_provider_name = main_provider_name
    if active_provider_name == "custom" and main_base_url:
        for cp in custom_list:
            if isinstance(cp, dict) and str(cp.get("base_url", "")).rstrip("/") == main_base_url.rstrip("/"):
                active_provider_name = str(cp.get("name", "custom"))
                break

    for cp in custom_list:
        if not isinstance(cp, dict):
            continue
        cname = cp.get("name", "")
        if not cname or cname in seen:
            continue
        seen.add(cname)
        key_env = cp.get("key_env", "") or ""
        actual_key = env_vars.get(key_env, "") if key_env else ""
        if not actual_key:
            actual_key = str(cp.get("api_key") or "")
        is_active = (cname == active_provider_name)
        raw_models = cp.get("models")
        if isinstance(raw_models, dict):
            model_ids = [str(k) for k in raw_models.keys()]
        elif isinstance(raw_models, list):
            model_ids = [
                (m if isinstance(m, str) else str(m.get("id") or m.get("name") or ""))
                for m in raw_models
            ]
            model_ids = [m for m in model_ids if m]
        else:
            model_ids = []
        result.append({
            "name": cname,
            "source": "custom",
            "base_url": cp.get("base_url", "") or "",
            "api_mode": str(cp.get("api_mode") or ""),
            "key_env": key_env,
            "api_key": cp.get("api_key", "") or "",
            "api_key_value": actual_key,
            "default_model": str(cp.get("default_model") or cp.get("model") or ""),
            "context_length": cp.get("context_length"),
            "rate_limit_delay": cp.get("rate_limit_delay"),
            "discover_models": cp.get("discover_models"),
            "models": model_ids,
            "extra_headers": cp.get("extra_headers") or {},
            "has_key": bool(env_vars.get(key_env)) if key_env else bool(cp.get("api_key")),
            "is_active": is_active,
        })

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
            "api_key_value": env_vars.get(info.get("key_env", ""), ""),
            "has_key": True,
            "is_active": (name == active_provider_name),
        })

    return result


@models_router.get("/providers")
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


def _load_provider_presets() -> list[dict[str, Any]]:
    presets: dict[str, dict[str, Any]] = {}
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

    PRIORITY = {"deepseek", "anthropic", "OpenAI API", "Google AI Studio", "xAI", "GitHub Copilot", "Qwen Cloud", "Z.AI / GLM"}
    result.sort(key=lambda p: (0 if p["name"] in PRIORITY else 1, p["name"]))

    return result


@models_router.get("/provider-presets")
def get_provider_presets(
    user: User = Depends(get_current_user),
):
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
        for key in ("multimodal", "supports_multimodal", "supports_vision", "vision"):
            val = item.get(key)
            if isinstance(val, bool):
                return val
    mid_lower = mid.lower()
    return any(kw in mid_lower for kw in _MULTIMODAL_KEYWORDS)


def _normalize_model_item(item: Any) -> dict[str, Any]:
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
            "context_length": item.get("context_length") or item.get("context_window"),
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


@models_router.get("/providers/{name}/models", response_model=ProviderModelsResult)
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

    key_env = str(provider.get("key_env", ""))
    api_key = env_vars.get(key_env, "") if key_env else ""
    if not api_key:
        fallback_key = f"{str(provider.get('name', name)).upper()}_API_KEY"
        api_key = env_vars.get(fallback_key, "")

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

    import requests as req_lib
    from requests.exceptions import RequestException

    models_url = f"{base_url}/models"
    try:
        session = req_lib.Session()
        session.trust_env = False
        resp = session.get(models_url, headers=headers, timeout=15)
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


@models_router.post("/custom_providers/test-connection", response_model=TestConnectionResult)
def test_custom_provider_connection(
    body: TestConnectionRequest,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    yaml_svc: YamlService = Depends(yaml_service),
):
    profile_name = ensure_profile_access(user, profile)

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

    env_svc = EnvService(yaml_svc.profiles.hermes_home)
    env_vars = env_svc.read_env(profile_name)

    api_key = ""
    key_env = provider.get("key_env", "")
    if key_env:
        api_key = env_vars.get(key_env, "")
    else:
        api_key = provider.get("api_key", "") or ""

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    import requests as req_lib
    from requests.exceptions import RequestException

    session = req_lib.Session()
    session.trust_env = False

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

    models_url = f"{base_url}/models"
    try:
        resp = session.get(models_url, headers=headers, timeout=15)
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

    if body.model:
        chat_url = f"{base_url}/chat/completions"
        chat_payload = {
            "model": body.model,
            "messages": [{"role": "user", "content": "Respond with exactly: OK"}],
            "max_tokens": 10,
            "temperature": 0,
        }
        try:
            chat_resp = session.post(chat_url, headers=headers, json=chat_payload, timeout=30)
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
    mode: str = "preset"
    provider_name: str = ""
    name: str = ""
    key_env_var: str = ""
    key_value: str = ""
    base_url: str = ""
    api_mode: str | None = None
    default_model: str | None = None
    context_length: int | None = None
    rate_limit_delay: float | None = None


@models_router.post("/providers", status_code=201)
def create_provider(
    payload: ProviderCreatePayload,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    yaml_svc: YamlService = Depends(yaml_service),
):
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

    if payload.key_value:
        env_svc.set_env_var(profile_name, env_key, payload.key_value)

    config = yaml_svc.read_config(profile_name)
    custom_list = config.get("custom_providers", [])
    if not isinstance(custom_list, list):
        custom_list = []
    if any(
        isinstance(item, dict) and str(item.get("name", "")).lower() == entry_name.lower()
        for item in custom_list
    ):
        raise HTTPException(status_code=400, detail=f"供应商 '{entry_name}' 已存在")
    next_list = [
        item for item in custom_list
        if not (isinstance(item, dict) and str(item.get("name", "")).lower() == entry_name.lower())
    ]
    next_list.append(entry)
    yaml_svc.write_section(profile_name, "custom_providers", next_list)

    return {"ok": True, "mode": payload.mode, "name": entry_name, "key_env": env_key}


class ProviderUpdatePayload(BaseModel):
    name: str
    base_url: str
    key_env: str = ""
    api_key: str = ""
    api_mode: str | None = None
    default_model: str | None = None
    context_length: int | None = None
    rate_limit_delay: float | None = None
    discover_models: bool | None = None
    models: list[str] | None = None
    extra_headers: dict[str, str] | None = None


@models_router.put("/providers/{name}")
def update_provider(
    name: str,
    payload: ProviderUpdatePayload,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    yaml_svc: YamlService = Depends(yaml_service),
):
    profile_name = ensure_profile_access(user, profile)
    env_svc = EnvService(yaml_svc.profiles.hermes_home)

    new_name = payload.name.strip()
    base_url = payload.base_url.strip()
    key_env = payload.key_env.strip()
    api_key = payload.api_key or ""

    if not new_name:
        raise HTTPException(status_code=400, detail="name 不能为空")
    if not base_url:
        raise HTTPException(status_code=400, detail="base_url 不能为空")

    config = yaml_svc.read_config(profile_name)
    custom_list = config.get("custom_providers", []) if isinstance(config, dict) else []
    if not isinstance(custom_list, list):
        custom_list = []

    original_lower = name.strip().lower()
    idx = next(
        (
            i
            for i, item in enumerate(custom_list)
            if isinstance(item, dict) and str(item.get("name", "")).strip().lower() == original_lower
        ),
        None,
    )
    if any(
        i != idx
        and isinstance(item, dict)
        and str(item.get("name", "")).strip().lower() == new_name.lower()
        for i, item in enumerate(custom_list)
    ):
        raise HTTPException(status_code=400, detail=f"供应商 '{new_name}' 已存在")

    old_entry = custom_list[idx] if idx is not None else {}
    old_key_env = str(old_entry.get("key_env", "") or "") if isinstance(old_entry, dict) else ""

    entry: dict[str, Any] = {**old_entry} if isinstance(old_entry, dict) else {}
    entry["name"] = new_name
    entry["base_url"] = base_url

    if key_env:
        entry["key_env"] = key_env
        entry.pop("api_key", None)
    else:
        entry.pop("key_env", None)
        if api_key:
            entry["api_key"] = api_key
        else:
            entry.pop("api_key", None)

    if payload.api_mode:
        entry["api_mode"] = payload.api_mode.strip()
    else:
        entry.pop("api_mode", None)
    if payload.default_model:
        entry["default_model"] = payload.default_model.strip()
        entry.pop("model", None)
    else:
        entry.pop("default_model", None)
        entry.pop("model", None)
    if payload.context_length is not None:
        entry["context_length"] = payload.context_length
    else:
        entry.pop("context_length", None)
    if payload.rate_limit_delay is not None:
        entry["rate_limit_delay"] = payload.rate_limit_delay
    else:
        entry.pop("rate_limit_delay", None)

    if payload.discover_models is not None:
        if payload.discover_models:
            entry.pop("discover_models", None)
        else:
            entry["discover_models"] = False
    if payload.models is not None:
        model_ids = [m.strip() for m in payload.models if isinstance(m, str) and m.strip()]
        if model_ids:
            entry["models"] = {mid: {} for mid in model_ids}
        else:
            entry.pop("models", None)
    if payload.extra_headers is not None:
        headers = {
            str(k).strip(): str(v)
            for k, v in payload.extra_headers.items()
            if str(k).strip()
        }
        if headers:
            entry["extra_headers"] = headers
        else:
            entry.pop("extra_headers", None)

    if key_env:
        if api_key:
            env_svc.set_env_var(profile_name, key_env, api_key)
        else:
            env_svc.delete_env_var(profile_name, key_env)
        if old_key_env and old_key_env != key_env:
            env_svc.delete_env_var(profile_name, old_key_env)
    elif old_key_env:
        env_svc.delete_env_var(profile_name, old_key_env)

    if idx is not None:
        custom_list[idx] = entry
    else:
        custom_list.append(entry)

    yaml_svc.write_section(profile_name, "custom_providers", custom_list)
    return {"ok": True, "name": new_name, "key_env": key_env}


def _registry_lookup_by_name(provider_name: str) -> tuple[str, dict[str, Any]] | None:
    target = provider_name.strip().lower()
    for env_key, info in _load_provider_registry().items():
        if str(info.get("name") or "").lower() == target:
            return env_key, info
    return None


# ── /admin ──────────────────────────────────────────────────────────────────

admin_router = APIRouter(prefix="/admin", tags=["admin"])


class ModelsCopyRequest(BaseModel):
    profiles: list[str] = Field(..., min_length=1)
    source_profile: str
    sections: list[str] = Field(..., min_length=1)


class ModelsSetRequest(BaseModel):
    profiles: list[str] = Field(..., min_length=1)
    values: dict[str, Any] = Field(..., min_length=1)


class SoulBatchRequest(BaseModel):
    profiles: list[str] = Field(..., min_length=1)
    content: str


def _client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def _backup_file(path: Path) -> None:
    if not path.exists():
        return
    backup = path.with_name(f"{path.name}.{int(time.time())}.bak")
    shutil.copy2(path, backup)


def _audit(
    request: Request,
    user: User,
    action: str,
    profiles: list[str],
    results: list[dict],
) -> None:
    succeeded = sum(1 for r in results if r.get("success"))
    log_audit_event(
        request.app.state.settings,
        action=action,
        actor=user.username,
        target_type="profiles",
        target_id=",".join(profiles),
        details={
            "profiles": profiles,
            "total": len(profiles),
            "succeeded": succeeded,
            "failed": len(profiles) - succeeded,
            "results": results,
        },
        success=(succeeded == len(profiles)),
        ip_address=_client_ip(request),
    )


def _apply_model_copy(
    yaml_svc: YamlService, source: str, profiles: list[str], sections: list[str]
) -> list[dict]:
    source_config = yaml_svc.read_config(source)
    env_svc = EnvService(yaml_svc.profiles.hermes_home)
    source_env = env_svc.read_env(source)
    key_envs_to_copy: set[str] = set()
    if "custom_providers" in sections and isinstance(source_config, dict):
        cp_list = source_config.get("custom_providers", [])
        if isinstance(cp_list, list):
            for cp in cp_list:
                if isinstance(cp, dict):
                    key_env = str(cp.get("key_env") or "").strip()
                    if key_env and source_env.get(key_env):
                        key_envs_to_copy.add(key_env)

    results: list[dict] = []
    for profile in profiles:
        try:
            if profile == source:
                results.append({"profile": profile, "success": True, "message": "源 profile，跳过"})
                continue
            for section in sections:
                value = source_config.get(section) if isinstance(source_config, dict) else None
                yaml_svc.write_section(profile, section, value)
            if key_envs_to_copy:
                updates: dict[str, str | None] = {k: source_env[k] for k in key_envs_to_copy}
                env_svc.write_env(profile, updates)
            copied_note = (
                f"已复制 {len(sections)} 个 section，密钥 {len(key_envs_to_copy)} 个"
                if key_envs_to_copy
                else f"已复制 {len(sections)} 个 section"
            )
            results.append({"profile": profile, "success": True, "message": copied_note})
        except Exception as exc:  # noqa: BLE001
            logger.exception("admin models copy: profile=%s failed", profile)
            results.append({"profile": profile, "success": False, "message": str(exc)})
    return results


def _apply_model_set(
    yaml_svc: YamlService, profiles: list[str], values: dict[str, Any]
) -> list[dict]:
    results: list[dict] = []
    for profile in profiles:
        try:
            for section, value in values.items():
                yaml_svc.write_section(profile, section, value)
            results.append({"profile": profile, "success": True, "message": f"已设置 {len(values)} 个 section"})
        except Exception as exc:  # noqa: BLE001
            logger.exception("admin models set: profile=%s failed", profile)
            results.append({"profile": profile, "success": False, "message": str(exc)})
    return results


@admin_router.post("/models/copy")
def models_copy(
    request: Request,
    body: ModelsCopyRequest,
    user: User = Depends(require_admin),
):
    for section in body.sections:
        if section not in MODEL_SECTIONS:
            raise HTTPException(status_code=400, detail=f"Invalid section: {section}")

    yaml_svc = YamlService()
    results = _apply_model_copy(yaml_svc, body.source_profile, body.profiles, body.sections)
    _audit(request, user, "admin:models:copy", body.profiles, results)
    return {"results": results}


@admin_router.post("/models/set")
def models_set(
    request: Request,
    body: ModelsSetRequest,
    user: User = Depends(require_admin),
):
    for section in body.values:
        if section not in MODEL_SECTIONS:
            raise HTTPException(status_code=400, detail=f"Invalid section: {section}")

    yaml_svc = YamlService()
    results = _apply_model_set(yaml_svc, body.profiles, body.values)
    _audit(request, user, "admin:models:set", body.profiles, results)
    return {"results": results}


@admin_router.post("/soul/batch")
def soul_batch(
    request: Request,
    body: SoulBatchRequest,
    user: User = Depends(require_admin),
):
    profile_svc = ProfileService()
    results: list[dict] = []
    for profile in body.profiles:
        try:
            root = profile_svc.profile_root(profile)
            soul_path = _resolve_soul_path(root)
            soul_path.parent.mkdir(parents=True, exist_ok=True)
            _backup_file(soul_path)
            atomic_write_text(soul_path, body.content)
            results.append({"profile": profile, "success": True, "message": "SOUL.md 已更新"})
        except Exception as exc:  # noqa: BLE001
            logger.exception("admin soul batch: profile=%s failed", profile)
            results.append({"profile": profile, "success": False, "message": str(exc)})

    _audit(request, user, "admin:soul:batch", body.profiles, results)
    return {"results": results}