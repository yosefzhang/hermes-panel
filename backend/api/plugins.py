"""Plugin management: list/enable/disable/remove via the hermes CLI."""
from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

from fastapi import APIRouter, Depends, Query

from backend.auth.dependencies import ensure_profile_access, get_current_user
from backend.db.models import User
from backend.services.cli_utils import TTLCache, get_profile_cmd_prefix, get_profile_env
from backend.services.profile_service import ProfileService


logger = logging.getLogger(__name__)

# `hermes plugins list --json` 每次都要起子进程，是插件页加载慢的主要来源。
# 按 profile 短时缓存解析后的插件列表；启停/删除等写操作会失效对应缓存。
_PLUGINS_CACHE_TTL = 30.0
_plugins_cache = TTLCache(_PLUGINS_CACHE_TTL)


router = APIRouter(prefix="/plugins", tags=["plugins"])


# First-level category mapping: roll raw sub-categories up to one of
# these top-level buckets for the navigation bar.
CATEGORY_MAPPING: dict[str, str] = {
    "model-providers": "model-provider",
    "platforms": "platforms",
    "web": "web",
    "browser": "web",
    "image_gen": "其他",
    "video_gen": "其他",
    "memory": "其他",
    "dashboard_auth": "其他",
    "cron_providers": "其他",
    "observability": "其他",
    "security-guidance": "其他",
    "google_meet": "其他",
    "spotify": "其他",
    "teams_pipeline": "其他",
    "disk-cleanup": "其他",
}
TOP_LEVEL_CATEGORIES = ["model-provider", "platforms", "web", "自定义", "其他"]


def map_to_top_category(category: str, source: str) -> str:
    """Roll *category* up to a top-level bucket for *source*."""
    if source != "bundled":
        return "自定义"
    return CATEGORY_MAPPING.get(category, "其他")


def get_config_dir() -> Path:
    """Return (and create) ~/.config/hermes-panel."""
    config_dir = Path.home() / ".config" / "hermes-panel"
    config_dir.mkdir(parents=True, exist_ok=True)
    return config_dir


def scan_bundled_plugins_manifest(force_refresh: bool = False) -> dict[str, str]:
    """Build a plugin-name → category map from the bundled plugins dir.

    The result is cached in `manifest.json` so the scan only runs once.
    """
    import yaml

    config_dir = get_config_dir()
    manifest_path = config_dir / "manifest.json"

    if not force_refresh and manifest_path.exists():
        try:
            with manifest_path.open("r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass

    manifest: dict[str, str] = {}
    bundled_plugins_dir = Path.home() / ".hermes" / "hermes-agent" / "plugins"
    if not bundled_plugins_dir.exists():
        return manifest

    for category_dir in bundled_plugins_dir.iterdir():
        if not category_dir.is_dir() or category_dir.name.startswith(("__", ".")):
            continue

        # The directory itself can be a plugin (plugin.yaml at root).
        plugin_yaml = category_dir / "plugin.yaml"
        if plugin_yaml.exists():
            try:
                data = yaml.safe_load(plugin_yaml.read_text(encoding="utf-8"))
                if data and "name" in data:
                    manifest[data["name"]] = category_dir.name
            except Exception:
                pass
            continue

        # Otherwise, look one level deeper.
        for plugin_dir in category_dir.iterdir():
            if not plugin_dir.is_dir() or plugin_dir.name.startswith(("__", ".")):
                continue
            plugin_yaml = plugin_dir / "plugin.yaml"
            if not plugin_yaml.exists():
                continue
            try:
                data = yaml.safe_load(plugin_yaml.read_text(encoding="utf-8"))
                if data and "name" in data:
                    manifest[data["name"]] = category_dir.name
            except Exception:
                continue

    try:
        with manifest_path.open("w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    return manifest


def _run_plugin_cmd(profile: str, *args: str, timeout: int = 30) -> dict:
    """Run a `hermes plugins <args>` command; return a normalised result dict."""
    cmd = get_profile_cmd_prefix(profile)
    if not cmd:
        return {"ok": False, "error": f"command not found: {'hermes' if profile == 'default' else profile}"}

    # 使用 hermes -p <profile> 格式调用 CLI，并设置对应 profile 的 HERMES_HOME
    env = get_profile_env(profile, ProfileService().hermes_home)

    try:
        full_cmd = [*cmd, "plugins", *args]
        logger.info("_run_plugin_cmd: running cmd=%s", full_cmd)
        result = subprocess.run(
            full_cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError) as exc:
        logger.error("_run_plugin_cmd: cmd=%s failed: %s", full_cmd, exc)
        return {"ok": False, "error": str(exc)}

    logger.info(
        "_run_plugin_cmd: cmd=%s rc=%d stdout_len=%d stderr_len=%d",
        full_cmd, result.returncode, len(result.stdout), len(result.stderr),
    )
    if result.returncode != 0:
        logger.warning(
            "_run_plugin_cmd: cmd=%s rc=%d stderr=%s",
            full_cmd, result.returncode, result.stderr[:500],
        )
        return {"ok": False, "error": result.stderr.strip() or "Plugin command failed"}
    return {"ok": True}


@router.get("")
def list_plugins(
    profile: str = Query("default"),
    refresh: bool = Query(False, description="是否强制刷新 manifest 与插件列表缓存"),
    user: User = Depends(get_current_user),
):
    ensure_profile_access(user, profile)

    if not refresh:
        cached = _plugins_cache.get(profile)
        if cached is not None:
            return {"plugins": cached}

    cmd = get_profile_cmd_prefix(profile)
    if not cmd:
        return {"plugins": [], "error": f"command not found: {'hermes' if profile == 'default' else profile}"}

    # 使用 hermes -p <profile> 格式调用 CLI，并设置对应 profile 的 HERMES_HOME
    env = get_profile_env(profile, ProfileService().hermes_home)

    bundled_manifest = scan_bundled_plugins_manifest(force_refresh=refresh)
    full_cmd = [*cmd, "plugins", "list", "--json"]
    logger.info("list_plugins: running cmd=%s", full_cmd)
    try:
        result = subprocess.run(
            full_cmd,
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError) as exc:
        logger.error("list_plugins: cmd=%s failed: %s", full_cmd, exc)
        return {"plugins": [], "error": str(exc)}
    except json.JSONDecodeError as exc:
        return {"plugins": [], "error": f"Failed to parse plugins JSON: {exc}"}

    logger.info(
        "list_plugins: cmd=%s rc=%d stdout_len=%d stderr_len=%d",
        full_cmd, result.returncode, len(result.stdout), len(result.stderr),
    )
    if result.returncode != 0:
        logger.warning(
            "list_plugins: cmd=%s rc=%d stderr=%s",
            full_cmd, result.returncode, result.stderr[:500],
        )
        return {"plugins": [], "error": result.stderr.strip() or "Failed to list plugins"}

    plugins = json.loads(result.stdout)
    for plugin in plugins:
        plugin["enabled"] = plugin.get("status") == "enabled"
        if plugin["source"] == "bundled":
            raw_category = bundled_manifest.get(plugin["name"], "其他")
            plugin["category"] = map_to_top_category(raw_category, plugin["source"])
        else:
            plugin["category"] = "自定义"
    _plugins_cache.set(profile, plugins)
    return {"plugins": plugins}


@router.post("/{name}/enable")
def enable_plugin(name: str, profile: str = Query("default"), user: User = Depends(get_current_user)):
    ensure_profile_access(user, profile)
    result = _run_plugin_cmd(profile, "enable", name)
    if not result["ok"]:
        return result
    _plugins_cache.invalidate(profile)
    return {"ok": True}


@router.post("/{name}/disable")
def disable_plugin(name: str, profile: str = Query("default"), user: User = Depends(get_current_user)):
    ensure_profile_access(user, profile)
    result = _run_plugin_cmd(profile, "disable", name)
    if not result["ok"]:
        return result
    _plugins_cache.invalidate(profile)
    return {"ok": True}


@router.delete("/{name}")
def delete_plugin(name: str, profile: str = Query("default"), user: User = Depends(get_current_user)):
    ensure_profile_access(user, profile)
    result = _run_plugin_cmd(profile, "remove", name)
    if not result["ok"]:
        return result
    _plugins_cache.invalidate(profile)
    return {"ok": True}
