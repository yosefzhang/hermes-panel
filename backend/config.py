from __future__ import annotations

import os
import shutil
from pathlib import Path

from pydantic import BaseModel, Field
from ruamel.yaml import YAML

CONFIG_DIR = Path.home() / ".config" / "hermes-panel"

# Project root: config.py lives in backend/, so parent is the project root
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_CONFIG_EXAMPLE = _PROJECT_ROOT / "config.yaml.example"

# Default components whose versions are queried by ``get_system_versions``.
# Each entry is ``{"command": str, "args": [str, ...]}``.
_DEFAULT_COMPONENT_VERSIONS: list[dict] = [
    {"name": "hermes", "command": "hermes", "args": ["--version"], "regex": r"v[\d.]+(?:\s*\([^)]+\))?"},
    {"name": "node", "command": "node", "args": ["--version"]},
    {"name": "npm", "command": "npm", "args": ["--version"]},
    {"name": "git", "command": "git", "args": ["--version"], "regex": r"(\d+\.\d+(?:\.\d+)?)"},
    {"name": "lark-cli", "command": "lark-cli", "args": ["--version"], "regex": r"(\d+\.\d+(?:\.\d+)?)"},
    {"name": "quectel-cli", "command": "quectel-cli", "args": ["--version"], "regex": r"v?(\d+\.\d+(?:\.\d+)?)"},
]


def _config_path() -> Path:
    """Return the resolved path to the panel's config.yaml."""
    return Path(
        os.environ.get("HERMES_PANEL_CONFIG", CONFIG_DIR / "config.yaml")
    ).expanduser()


def _ensure_config_file(path: Path) -> None:
    """Create config.yaml from config.yaml.example if missing."""
    if path.is_file():
        return
    if _CONFIG_EXAMPLE.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(_CONFIG_EXAMPLE, path)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("", encoding="utf-8")


def _load_config_file() -> dict:
    """Load the panel's ``config.yaml`` and return it as a plain dict.

    Real environment variables always take priority over file values for
    the keys that have a corresponding env-var override (see *Settings*
    field defaults).
    """
    path = _config_path()
    _ensure_config_file(path)
    if not path.is_file():
        return {}
    yaml = YAML(typ="safe")
    data = yaml.load(path.read_text(encoding="utf-8"))
    return data or {}


def _save_config_file(data: dict) -> None:
    """Write *data* back to config.yaml preserving key order."""
    path = _config_path()
    _ensure_config_file(path)
    yaml = YAML()
    yaml.default_flow_style = False
    yaml.dump(data, path)


class Settings(BaseModel):
    app_name: str = "Hermes Panel"
    api_prefix: str = "/api/v1"
    host: str = "0.0.0.0"
    port: int = 8650
    hermes_home: Path = Field(default_factory=lambda: (Path.home() / ".hermes").expanduser())
    # Unified database file. All panel tables (control, profile stats, host info)
    # live in this single SQLite database. Defaults to hermes-panel.db.
    hermes_panel_db_path: Path = Field(
        default_factory=lambda: Path(
            os.environ.get("HERMES_PANEL_DB") or (CONFIG_DIR / "hermes-panel.db")
        ).expanduser()
    )
    # Log file location. Defaults to ~/.config/hermes-panel/hermes-panel.log
    # and can be overridden via HERMES_PANEL_LOG_FILE. A rotating handler
    # keeps at most ``log_backup_count`` archived files of size
    # ``log_max_bytes`` each.
    log_file_path: Path = Field(
        default_factory=lambda: Path(
            os.environ.get("HERMES_PANEL_LOG_FILE") or (CONFIG_DIR / "hermes-panel.log")
        ).expanduser()
    )
    log_max_bytes: int = Field(
        default_factory=lambda: int(os.environ.get("HERMES_PANEL_LOG_MAX_BYTES", str(5 * 1024 * 1024)))
    )
    log_backup_count: int = Field(
        default_factory=lambda: int(os.environ.get("HERMES_PANEL_LOG_BACKUP_COUNT", "5"))
    )
    log_level: str = Field(
        default_factory=lambda: os.environ.get("HERMES_PANEL_LOG_LEVEL", "INFO").upper()
    )
    jwt_secret: str = Field(
        default_factory=lambda: os.environ.get(
            "HERMES_PANEL_JWT_SECRET",
            "change-me-in-production-hermes-panel-secret-key",
        )
    )
    jwt_algorithm: str = "HS256"
    jwt_expires_hours: int = 24
    default_admin_password: str = Field(
        default_factory=lambda: (
            os.environ.get("HERMES_PANEL_DEFAULT_ADMIN_PASSWORD")
            or os.environ.get("HERMES_PANEL_DEFAULT_PASSWORD")
            or "admin"
        )
    )
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:8650"]

    # Data sync to another hermes-panel instance.
    # When enabled, local host_info and profile_info tables are periodically
    # POSTed to the configured target panel.
    # Inbound sync is accepted at /api/v1/sync/ (panel-to-panel and external
    # systems alike); it verifies the receive token.
    sync_enabled: bool = False
    sync_receive_enabled: bool = False
    sync_target_url: str | None = None
    # send / receive tokens are separate keys, but fall back to the legacy
    # shared "token" key so existing config.yaml files keep working.
    sync_send_token: str | None = None
    sync_receive_token: str | None = None
    sync_interval: int = 600

    # Components whose versions are queried via CLI for the dashboard.
    # Each entry: {"name": str, "command": str, "args": [str, ...]}
    component_versions: list[dict] = Field(
        default_factory=lambda: list(_DEFAULT_COMPONENT_VERSIONS)
    )


def _build_settings_from_file(data: dict) -> Settings:
    """Build a Settings instance from the YAML config dict.

    Environment variables (if set) override file values for the keys that
    support env-var overrides.
    """
    sync = data.get("sync", {}) or {}
    return Settings(
        hermes_home=Path(
            os.environ.get("HERMES_PATH")
            or data.get("hermes_path")
            or (Path.home() / ".hermes")
        ).expanduser(),
        hermes_panel_db_path=Path(
            os.environ.get("HERMES_PANEL_DB")
            or data.get("db_path")
            or (CONFIG_DIR / "hermes-panel.db")
        ).expanduser(),
        log_file_path=Path(
            os.environ.get("HERMES_PANEL_LOG_FILE")
            or data.get("log_file")
            or (CONFIG_DIR / "hermes-panel.log")
        ).expanduser(),
        log_level=(
            os.environ.get("HERMES_PANEL_LOG_LEVEL")
            or str(data.get("log_level", "INFO"))
        ).upper(),
        jwt_secret=(
            os.environ.get("HERMES_PANEL_JWT_SECRET")
            or data.get("jwt_secret")
            or "change-me-in-production-hermes-panel-secret-key"
        ),
        default_admin_password=(
            os.environ.get("HERMES_PANEL_DEFAULT_ADMIN_PASSWORD")
            or os.environ.get("HERMES_PANEL_DEFAULT_PASSWORD")
            or data.get("default_admin_password")
            or "admin"
        ),
        sync_enabled=bool(sync.get("enabled", False)),
        sync_receive_enabled=bool(sync.get("receive_enabled", False)),
        sync_target_url=sync.get("target_url"),
        # send / receive tokens are separate keys, but fall back to the legacy
        # shared "token" key so existing config.yaml files keep working.
        sync_send_token=sync.get("send_token", sync.get("token")),
        sync_receive_token=sync.get("receive_token", sync.get("token")),
        sync_interval=int(sync.get("interval", 600)),
        component_versions=data.get("component_versions") or list(_DEFAULT_COMPONENT_VERSIONS),
    )


def update_config_file(updates: dict) -> None:
    """Merge *updates* into config.yaml and persist.

    *updates* is a dict matching the top-level config.yaml structure, e.g.::

        {"sync": {"enabled": True, "target_url": "http://..."}}
    """
    data = _load_config_file()
    _deep_merge(data, updates)
    _save_config_file(data)


def _deep_merge(base: dict, override: dict) -> None:
    """Recursively merge *override* into *base* (in-place)."""
    for key, value in override.items():
        if (
            key in base
            and isinstance(base[key], dict)
            and isinstance(value, dict)
        ):
            _deep_merge(base[key], value)
        else:
            base[key] = value


def get_settings() -> Settings:
    """Build a fresh Settings from config.yaml (with env-var overrides)."""
    data = _load_config_file()
    return _build_settings_from_file(data)
