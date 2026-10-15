"""Panel 自有数据模型与 JSON/JSONL 存储层。

面板自身只保存少量数据，不使用 SQLite，改为以下文件：

- ``users.json``            — 登录用户（JSON 列表）
- ``local_profiles.json``   — 本机采集的 profile 统计（JSON 列表）
- ``<panel_name>_profiles.json`` — 各远程面板上报的 profile 统计（JSON 列表）
- ``audit.log``             — 审计流水（JSONL，追加写）

集合读写为原子操作，并用 per-file 锁保证后台刷新循环、同步接收与请求处理器之间
不会互相破坏；日志文件每条记录一行 JSON 追加。
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from passlib.hash import pbkdf2_sha256

from backend.config import Settings

logger = logging.getLogger(__name__)


# ── 数据模型 ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Profile:
    id: int
    profile_name: str
    path: str | None
    session_count: int
    total_tokens: int
    total_input_tokens: int
    total_output_tokens: int
    cache_hit_rate: float
    model_top5: list[dict]
    provider_top5: list[dict]
    daily_tokens: list[dict]
    model_daily: list[dict]
    updated_at: float
    source: str = "local"
    panel_name: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "profile_name": self.profile_name,
            "path": self.path,
            "session_count": self.session_count,
            "total_tokens": self.total_tokens,
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
            "cache_hit_rate": self.cache_hit_rate,
            "model_top5": self.model_top5,
            "provider_top5": self.provider_top5,
            "daily_tokens": self.daily_tokens,
            "model_daily": self.model_daily,
            "updated_at": self.updated_at,
            "source": self.source,
            "panel_name": self.panel_name,
        }


@dataclass(frozen=True)
class User:
    id: int
    username: str
    password_hash: str
    role: str
    profiles: list[str]
    created_at: float
    updated_at: float

    def public_dict(self) -> dict:
        return {
            "id": self.id,
            "username": self.username,
            "role": self.role,
            "profiles": self.profiles,
        }


# ── 文件读写 ────────────────────────────────────────────────────────────────


_file_locks: dict[Path, threading.Lock] = {}
_file_locks_guard = threading.Lock()


def _lock_for(path: Path) -> threading.Lock:
    with _file_locks_guard:
        if path not in _file_locks:
            _file_locks[path] = threading.Lock()
        return _file_locks[path]


def _atomic_write(path: Path, data: list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


class JsonCollection:
    """一个 JSON 文件承载的 dict 记录列表。

    每次读写在 per-file 锁内进行；写入通过临时文件 rename 实现原子性，
    崩溃时不会留下半写状态的文件。
    """

    def __init__(self, path: Path):
        self.path = Path(path)

    def _read(self) -> list[dict]:
        if not self.path.is_file():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            logger.exception("json_store: failed to read %s, treating as empty", self.path)
            return []
        return data if isinstance(data, list) else []

    def _write(self, items: list[dict]) -> None:
        _atomic_write(self.path, items)

    def read(self) -> list[dict]:
        with _lock_for(self.path):
            return self._read()

    def write(self, items: list[dict]) -> None:
        with _lock_for(self.path):
            self._write(items)

    def mutate(self, fn: Callable[[list[dict]], None]) -> list[dict]:
        """在锁内读取、原地修改、再持久化。"""
        with _lock_for(self.path):
            items = self._read()
            fn(items)
            self._write(items)
            return items


def append_jsonl(path: Path, record: dict, max_bytes: int | None = None) -> None:
    """向 JSONL 日志文件追加一条记录。

    设置 *max_bytes* 且文件超过该大小时，裁剪掉最旧的一半以控制磁盘占用。
    """
    path = Path(path)
    with _lock_for(path):
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        if max_bytes is not None:
            try:
                if path.stat().st_size > max_bytes:
                    _trim_jsonl(path)
            except OSError:
                pass


def read_jsonl(path: Path) -> list[dict]:
    """读取 JSONL 文件为记录列表（按最旧在前顺序）。"""
    path = Path(path)
    with _lock_for(path):
        if not path.is_file():
            return []
        records: list[dict] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except Exception:
                continue
        return records


def _trim_jsonl(path: Path) -> None:
    records = read_jsonl(path)
    if not records:
        return
    keep = records[len(records) // 2 :]
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in keep),
        encoding="utf-8",
    )
    os.replace(tmp, path)


def next_id(items: list[dict], key: str = "id") -> int:
    """返回 ``max(id)+1``（空列表时返回 1）。"""
    if not items:
        return 1
    return max(int(item.get(key, 0)) for item in items) + 1


# ── 密码哈希 ────────────────────────────────────────────────────────────────


def hash_password(password: str) -> str:
    return pbkdf2_sha256.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pbkdf2_sha256.verify(password, password_hash)


# ── 存储门面 ────────────────────────────────────────────────────────────────

_REMOTE_PROFILES_SUFFIX = "_profiles.json"


def _safe_panel_filename(panel_name: str) -> str:
    """把 panel_name 净化为安全文件名（只保留字母、数字、_ 与 -）。"""
    cleaned = "".join(ch if ch.isalnum() or ch in ("_", "-") else "_" for ch in panel_name)
    return cleaned.strip("_") or "unknown"


class JsonStore:
    """把面板所有的 JSON/JSONL 文件归到一个数据目录下。"""

    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.users = JsonCollection(self.data_dir / "users.json")
        self.local_profiles = JsonCollection(self.data_dir / "local_profiles.json")
        self.audit_log = self.data_dir / "audit.log"

    def remote_profiles(self, panel_name: str) -> JsonCollection:
        """返回某个远程面板 profile 记录的集合（按 panel_name 分文件）。"""
        safe = _safe_panel_filename(panel_name)
        return JsonCollection(self.data_dir / f"{safe}{_REMOTE_PROFILES_SUFFIX}")

    def list_remote_panels(self) -> list[str]:
        """列出所有存在的远程面板文件名（未经净化的安全名）。"""
        if not self.data_dir.is_dir():
            return []
        panels: list[str] = []
        for path in self.data_dir.glob(f"*{_REMOTE_PROFILES_SUFFIX}"):
            if path.name == "local_profiles.json":
                continue
            panels.append(path.name[: -len(_REMOTE_PROFILES_SUFFIX)])
        return panels

    def iter_remote_profiles(self):
        """逐个产出 ``(安全面板名, 记录列表)`` 供聚合读取。"""
        for safe_name in self.list_remote_panels():
            path = self.data_dir / f"{safe_name}{_REMOTE_PROFILES_SUFFIX}"
            yield safe_name, JsonCollection(path).read()


_INITIAL_FILES = {
    "users": "users.json",
    "local_profiles": "local_profiles.json",
}


def init_storage(settings: Settings) -> None:
    """创建数据目录与 JSON 文件，并播种默认 admin 用户。"""
    data_dir = Path(settings.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)

    # 迁移：旧版 profiles.json 迁移为 local_profiles.json（仅本机采集数据）。
    old_profiles = data_dir / "profiles.json"
    new_local = data_dir / "local_profiles.json"
    if old_profiles.is_file() and not new_local.is_file():
        try:
            old_profiles.replace(new_local)
            logger.info("init_storage: migrated profiles.json -> local_profiles.json")
        except OSError:
            logger.exception("init_storage: failed to migrate profiles.json")

    for filename in _INITIAL_FILES.values():
        path = data_dir / filename
        if not path.is_file():
            _atomic_write(path, [])

    users = JsonCollection(data_dir / "users.json").read()
    if not users:
        now = time.time()
        JsonCollection(data_dir / "users.json").write(
            [
                {
                    "id": 1,
                    "username": settings.default_admin_username,
                    "password_hash": hash_password(settings.default_admin_password),
                    "role": "admin",
                    "profiles": ["*"],
                    "created_at": now,
                    "updated_at": now,
                }
            ]
        )
        logger.info("init_storage: created default admin user")
    logger.info("init_storage: storage ready at %s", data_dir)