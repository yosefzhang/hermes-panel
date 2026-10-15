from __future__ import annotations

import os
import secrets
from pathlib import Path

from pydantic import BaseModel, Field
from ruamel.yaml import YAML


def _default_config_dir() -> Path:
    """Panel 自身数据根目录（config.yaml、JSON 数据、日志都放在这里）。

    默认 ``./data``（相对当前工作目录；Docker 中即 /app/data，由
    docker-compose 挂载宿主机 ./data 持久化）。可用 ``HERMES_PANEL_DATA_DIR``
    覆盖为绝对路径（如 ``~/.config/hermes-panel``）。
    """
    env = os.environ.get("HERMES_PANEL_DATA_DIR")
    if env:
        return Path(env).expanduser()
    return Path.cwd() / "data"


CONFIG_DIR = _default_config_dir()

# 最小化初始 config.yaml：首次启动、配置文件不存在时生成。
_MINIMAL_CONFIG = """\
# Hermes Panel 配置
hermes_path: ~/.hermes
port: 8090
"""


def _config_path() -> Path:
    """返回面板 config.yaml 的路径，位于面板数据目录下（见 ``_default_config_dir``）。

    Docker 中即容器内 /app/data/config.yaml，随宿主机 ./data 目录持久化；
    与挂载文件不同，目录挂载不会触发 Docker 自动创建同名目录的问题。
    """
    return CONFIG_DIR / "config.yaml"


def _ensure_config_file(path: Path) -> None:
    """config.yaml 不存在时，生成一个最小化的初始配置。"""
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_MINIMAL_CONFIG, encoding="utf-8")


def _load_config_file() -> dict:
    """Load the panel's ``config.yaml`` and return it as a plain dict.

    All Panel settings are read from this YAML file.
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
    port: int = 8090
    # 本面板的唯一标识，用于在接收端区分不同发送面板。缺省时首次启动自动
    # 生成一个唯一 ID 并回写 config.yaml。
    panel_name: str | None = None
    hermes_home: Path = Field(default_factory=lambda: (Path.home() / ".hermes").expanduser())
    # Directory for the panel's own JSON/JSONL data files (users, profiles,
    # audit log). Defaults to the config directory.
    data_dir: Path = Field(default_factory=lambda: CONFIG_DIR)
    # Log file location. A rotating handler
    # keeps at most ``log_backup_count`` archived files of size
    # ``log_max_bytes`` each.
    log_file_path: Path = Field(
        default_factory=lambda: CONFIG_DIR / "hermes-panel.log"
    )
    log_max_bytes: int = Field(
        default=5 * 1024 * 1024
    )
    log_backup_count: int = Field(
        default=5
    )
    log_level: str = Field(
        default="INFO"
    )
    jwt_secret: str = Field(
        default="change-me-in-production-hermes-panel-secret-key"
    )
    jwt_algorithm: str = "HS256"
    jwt_expires_hours: int = 24
    # 初始管理员凭据，仅在首次启动播种 users.json 时使用。
    # 密码可通过环境变量 HERMES_PANEL_ADMIN_PASSWORD 覆盖（Docker 部署推荐
    # 用 .env 注入，避免凭据写进挂载的 config.yaml）。
    default_admin_password: str = Field(
        default="admin"
    )
    # 用户名同理，可通过环境变量 HERMES_PANEL_ADMIN_USERNAME 覆盖。
    default_admin_username: str = Field(
        default="admin"
    )
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:8650"]

    # Data sync to another hermes-panel instance.
    # When enabled, local profile stats are periodically POSTed to the
    # configured target panel.
    # Inbound sync is accepted at /api/v1/sync/ (panel-to-panel and external
    # systems alike); it verifies the receive token.
    sync_enabled: bool = False
    sync_receive_enabled: bool = False
    sync_target_url: str | None = None
    # Outbound and inbound sync credentials are configured independently.
    sync_send_token: str | None = None
    sync_send_endpoints: list[dict] = Field(default_factory=list)
    sync_receive_token: str | None = None
    sync_interval: int = 600


def _build_settings_from_file(data: dict) -> Settings:
    """Build a Settings instance from the YAML config dict.

    All values come from the YAML configuration.
    """
    sync = data.get("sync", {}) or {}
    send_sync = sync.get("send", {}) or {}
    receive_sync = sync.get("receive", {}) or {}

    # 初始管理员凭据支持环境变量覆盖（仅此两项，其余配置仍只从 YAML 读取）：
    # 部署时凭据走 .env / 环境变量，不必写入挂载的 config.yaml。
    admin_username = (
        os.environ.get("HERMES_PANEL_ADMIN_USERNAME")
        or data.get("default_admin_username")
        or "admin"
    )
    admin_password = (
        os.environ.get("HERMES_PANEL_ADMIN_PASSWORD")
        or data.get("default_admin_password")
        or "admin"
    )
    return Settings(
        port=int(data.get("port", 8090)),
        panel_name=data.get("panel_name"),
        hermes_home=Path(data.get("hermes_path") or (Path.home() / ".hermes")).expanduser(),
        data_dir=Path(data.get("data_dir") or CONFIG_DIR).expanduser(),
        log_file_path=Path(data.get("log_file") or (CONFIG_DIR / "hermes-panel.log")).expanduser(),
        log_level=str(data.get("log_level", "INFO")).upper(),
        jwt_secret=data.get("jwt_secret") or "change-me-in-production-hermes-panel-secret-key",
        default_admin_username=admin_username,
        default_admin_password=admin_password,
        sync_enabled=bool(send_sync.get("enabled", False)),
        sync_receive_enabled=bool(receive_sync.get("enabled", False)),
        sync_target_url=send_sync.get("endpoint"),
        sync_send_token=send_sync.get("token"),
        sync_send_endpoints=list(send_sync.get("endpoints") or []),
        sync_receive_token=receive_sync.get("token"),
        sync_interval=int(send_sync.get("interval", 600)),
    )


def update_config_file(updates: dict) -> None:
    """Merge *updates* into config.yaml and persist.

    *updates* is a dict matching the top-level config.yaml structure, e.g.::

        {"sync": {"send": {"enabled": True, "endpoint": "http://..."}}}
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


def _generate_jwt_secret() -> str:
    """生成 32 字节（64 位十六进制）随机 JWT 密钥，满足 HS256 至少 32 字节要求。"""
    return secrets.token_hex(32)


def _ensure_jwt_secret(data: dict) -> None:
    """config.yaml 缺少 jwt_secret 时生成随机值并回写保存（首次启动）。"""
    if data.get("jwt_secret"):
        return
    data["jwt_secret"] = _generate_jwt_secret()
    _save_config_file(data)


def _generate_panel_name() -> str:
    """生成一个默认的唯一面板标识（可被用户在 config.yaml 中覆盖）。"""
    return f"panel-{secrets.token_hex(4)}"


def _ensure_panel_name(data: dict) -> None:
    """config.yaml 缺少 panel_name 时生成唯一 ID 并回写保存（首次启动）。"""
    if data.get("panel_name"):
        return
    data["panel_name"] = _generate_panel_name()
    _save_config_file(data)


def get_settings() -> Settings:
    """Build a fresh Settings from config.yaml."""
    data = _load_config_file()
    _ensure_jwt_secret(data)
    _ensure_panel_name(data)
    return _build_settings_from_file(data)
