from __future__ import annotations

import os
import shutil
from pathlib import Path

from pydantic import BaseModel, Field

CONFIG_DIR = Path.home() / ".config" / "hermes-panel"

# Project root: config.py lives in backend/, so parent is the project root
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_ENV_EXAMPLE = _PROJECT_ROOT / ".env.example"


def _ensure_env_file(env_path: Path) -> None:
    """Create ~/.config/hermes-panel/.env from .env.example if missing."""
    if env_path.is_file():
        return
    if not _ENV_EXAMPLE.is_file():
        return
    env_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(_ENV_EXAMPLE, env_path)


def _load_env_file() -> None:
    """Load Panel's own `.env` into `os.environ` before building Settings.

    Path defaults to `~/.config/hermes-panel/.env` and can be overridden
    with `HERMES_PANEL_ENV`. Existing environment variables always win, so
    real env / shell exports take priority over the file.

    If the .env file does not exist, it is automatically created from the
    project's .env.example template.
    """
    env_path = Path(os.environ.get("HERMES_PANEL_ENV", CONFIG_DIR / ".env")).expanduser()
    _ensure_env_file(env_path)
    if not env_path.is_file():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


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
    # When enabled, local profiles (profile stats + host metadata) are periodically
    # POSTed to the configured target panel.
    sync_enabled: bool = Field(
        default_factory=lambda: os.environ.get("SYNC_ENABLED", "false").lower() in ("true", "1", "yes")
    )
    sync_receive_enabled: bool = Field(
        default_factory=lambda: os.environ.get("SYNC_RECEIVE_ENABLED", "false").lower() in ("true", "1", "yes")
    )
    sync_target_url: str | None = Field(
        default_factory=lambda: os.environ.get("SYNC_TARGET_URL") or None
    )
    sync_token: str | None = Field(
        default_factory=lambda: os.environ.get("SYNC_TOKEN") or None
    )
    sync_interval: int = Field(
        default_factory=lambda: int(os.environ.get("SYNC_INTERVAL", "600"))
    )


def update_env_file(updates: dict[str, str | None]) -> None:
    """Write key/value pairs to the Panel's own `.env` file.

    Missing keys are appended, existing keys are updated in-place, and keys
    set to ``None`` are removed. Preserves comments and blank lines.
    """
    env_path = Path(os.environ.get("HERMES_PANEL_ENV", CONFIG_DIR / ".env")).expanduser()
    _ensure_env_file(env_path)
    if not env_path.is_file():
        env_path.parent.mkdir(parents=True, exist_ok=True)
        env_path.write_text("", encoding="utf-8")

    lines = env_path.read_text(encoding="utf-8").splitlines(keepends=True)
    if not lines:
        lines = [""]

    # Ensure final newline
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"

    seen: set[str] = set()
    new_lines: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            new_lines.append(line)
            continue
        key, _, _ = stripped.partition("=")
        key = key.strip()
        if key in updates:
            seen.add(key)
            value = updates[key]
            if value is not None:
                new_lines.append(f'{key}={value}\n')
            continue
        new_lines.append(line)

    for key, value in updates.items():
        if key not in seen and value is not None:
            new_lines.append(f'{key}={value}\n')

    env_path.write_text("".join(new_lines), encoding="utf-8")


def get_settings() -> Settings:
    _load_env_file()
    return Settings()
