from __future__ import annotations

import os
from pathlib import Path

from pydantic import BaseModel, Field

CONFIG_DIR = Path.home() / ".config" / "hermes-panel"


def _load_env_file() -> None:
    """Load Panel's own `.env` into `os.environ` before building Settings.

    Path defaults to `~/.config/hermes-panel/.env` and can be overridden
    with `HERMES_PANEL_ENV`. Existing environment variables always win, so
    real env / shell exports take priority over the file.
    """
    env_path = Path(os.environ.get("HERMES_PANEL_ENV", CONFIG_DIR / ".env")).expanduser()
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
    hermes_home: Path = Field(default_factory=lambda: Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")).expanduser())
    control_db_path: Path = Field(default_factory=lambda: Path(os.environ.get("HERMES_PANEL_DB", CONFIG_DIR / "control.db")).expanduser())
    jwt_secret: str = Field(default_factory=lambda: os.environ.get("HERMES_PANEL_JWT_SECRET", "change-me-in-production"))
    jwt_algorithm: str = "HS256"
    jwt_expires_hours: int = 24
    default_admin_password: str = Field(default_factory=lambda: os.environ.get("HERMES_PANEL_DEFAULT_ADMIN_PASSWORD", "admin"))
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:8650"]


def get_settings() -> Settings:
    _load_env_file()
    return Settings()
