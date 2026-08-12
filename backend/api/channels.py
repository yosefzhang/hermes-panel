from typing import Any
from pathlib import Path

from fastapi import APIRouter, Depends, Query

from backend.api.config import yaml_service
from backend.auth.dependencies import ensure_profile_access, get_current_user
from backend.db.models import User
from backend.services.env_service import EnvService
from backend.services.yaml_service import YamlService


router = APIRouter(prefix="/channels", tags=["channels"])

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

# 渠道的 env 变量标识 — 只要有该变量就视为"已配置"
CHANNEL_ENV_MARKERS: dict[str, str] = {
    "feishu": "FEISHU_APP_ID",
    "weixin": "WEIXIN_ACCOUNT_ID",
    "telegram": "TELEGRAM_BOT_TOKEN",
    "discord": "DISCORD_BOT_TOKEN",
    "slack": "SLACK_BOT_TOKEN",
}
# 部分渠道还可能有备选标识
CHANNEL_ENV_ALT_MARKERS: dict[str, list[str]] = {
    "weixin": ["WEIXIN_TOKEN"],
}


def _read_env_vars_for_profile(profile: str | None, hermes_home: Path | None = None) -> dict[str, str]:
    """读取 profile 的 .env 文件"""
    svc = EnvService(hermes_home=hermes_home)
    return svc.read_env(profile)


def _detect_env_channels(profile: str | None, hermes_home: Path | None = None) -> set[str]:
    """从 .env 中检测已配置的消息渠道"""
    env = _read_env_vars_for_profile(profile, hermes_home)
    configured: set[str] = set()
    for name in CHANNEL_NAMES:
        marker = CHANNEL_ENV_MARKERS.get(name)
        if marker and marker in env:
            configured.add(name)
            continue
        alt_markers = CHANNEL_ENV_ALT_MARKERS.get(name, [])
        for alt in alt_markers:
            if alt in env:
                configured.add(name)
                break
    return configured

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

    # 视图层返回“基础配置 + platforms 覆盖”，并将 enabled 与 platforms 对齐
    if isinstance(direct, dict) or isinstance(platform_channel, dict):
        base: dict[str, Any] = direct if isinstance(direct, dict) else {}
        view = _deep_merge_dict(base, platform_channel if isinstance(platform_channel, dict) else {})
        if isinstance(platform_channel, dict):
            view["enabled"] = bool(platform_channel.get("enabled", True))
        else:
            # 未出现在 platforms 里，视为未启用
            view["enabled"] = False
        return view

    return None


def _has_non_empty_credential(value: Any, key: str | None = None) -> bool:
    if isinstance(value, dict):
        for child_key, child_value in value.items():
            if _has_non_empty_credential(child_value, str(child_key)):
                return True
        return False

    if isinstance(value, list):
        return any(_has_non_empty_credential(item) for item in value)

    if key and key.lower() in CHANNEL_CREDENTIAL_FIELDS:
        if isinstance(value, str):
            return bool(value.strip())
        return bool(value)

    return False


def _is_channel_configured(name: str, channel: dict[str, Any]) -> bool:
    # webhook 以 enabled 或 routes/secret 作为有效配置依据
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

    # 其他渠道：必须存在至少一个凭据类配置字段
    return _has_non_empty_credential(channel)


def _write_channel_to_config(config: dict[str, Any], name: str, payload: dict[str, Any]) -> None:
    # 仅更新 enabled 时，始终写到 platforms.<name>.enabled（对齐 Hermes 生效逻辑）
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
        raw_current = config.get(name)
        current: dict[str, Any] = raw_current if isinstance(raw_current, dict) else {}
        config[name] = _deep_merge_dict(current, payload)
        return

    platforms = config.get("platforms")
    if isinstance(platforms, dict) and name in platforms and isinstance(platforms.get(name), dict):
        raw_current = platforms.get(name)
        current: dict[str, Any] = raw_current if isinstance(raw_current, dict) else {}
        platforms[name] = _deep_merge_dict(current, payload)
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


@router.get("")
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

    # 补充仅通过 .env 配置的渠道
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


@router.get("/{name}")
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


@router.put("/{name}")
def update_channel(
    name: str,
    payload: dict[str, Any],
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    safe_profile = ensure_profile_access(user, profile)
    config = service.read_config(safe_profile)
    if not isinstance(config, dict):
        config = {}

    _write_channel_to_config(config, name, payload)
    service.write_config(safe_profile, config)
    return {"ok": True}


@router.delete("/{name}")
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


# ── Env-based channel editing ─────────────────────────


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
}


@router.get("/{name}/env")
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


@router.put("/{name}/env")
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