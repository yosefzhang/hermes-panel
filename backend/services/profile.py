"""Hermes 文件与运行时状态的读取/写入服务。

涵盖 profile 发现、config.yaml / .env / SKILL.md 的读写，
以及原子文件写入辅助函数。面板不再通过 ``hermes`` CLI 操作，仅做文件级操作。
"""
from __future__ import annotations

import fcntl
import hashlib
import io
import json
import logging
import os
import re
import shutil
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ruamel.yaml import YAML

logger = logging.getLogger(__name__)


# ── 原子文件写入 ────────────────────────────────────────────────────────────


def atomic_write_text(path: Path, content: str) -> None:
    """原子写入 *content* 到 *path*（临时文件 + ``os.replace``）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as tmp:
        tmp.write(content)
        tmp_path = Path(tmp.name)
    os.replace(tmp_path, path)


# ── Profile 发现 ────────────────────────────────────────────────────────────


DEFAULT_PROFILE = "default"


@dataclass(frozen=True)
class ProfileInfo:
    name: str
    config_path: Path
    env_path: Path
    state_db_path: Path
    skills_path: Path
    exists: bool


class ProfileService:
    """发现并管理 Hermes profiles。

    面板自动扫描 Hermes 数据目录下的 profiles；数据目录由面板显式传入。
    """

    def __init__(self, hermes_home: Path | None = None):
        self.hermes_home = hermes_home or (Path.home() / ".hermes")

    def normalize_profile(self, profile: str | None) -> str:
        return profile or DEFAULT_PROFILE

    def profile_root(self, profile: str | None) -> Path:
        """获取某个 profile 的根目录。"""
        profile_name = self.normalize_profile(profile)
        if profile_name == DEFAULT_PROFILE:
            return self.hermes_home
        return self.hermes_home / "profiles" / profile_name

    def get_config_path(self, profile: str | None) -> Path:
        return self.profile_root(profile) / "config.yaml"

    def get_env_path(self, profile: str | None) -> Path:
        return self.profile_root(profile) / ".env"

    def get_state_db_path(self, profile: str | None) -> Path:
        return self.profile_root(profile) / "state.db"

    def get_skills_path(self, profile: str | None) -> Path:
        return self.profile_root(profile) / "skills"

    def list_profiles(self) -> list[str]:
        """发现 Hermes 数据目录下所有 profiles。"""
        profiles = [DEFAULT_PROFILE]
        profiles_dir = self.hermes_home / "profiles"
        if not profiles_dir.is_dir():
            logger.debug("list_profiles: profiles dir not found at %s", profiles_dir)
            return profiles

        discovered = sorted(
            child.name
            for child in profiles_dir.iterdir()
            if child.is_dir() and (child / "config.yaml").exists()
        )
        logger.debug("list_profiles: found %d profiles: %s", len(profiles) + len(discovered), profiles + discovered)
        return profiles + discovered

    def get_profile_info(self, profile: str | None) -> ProfileInfo:
        profile_name = self.normalize_profile(profile)
        config_path = self.get_config_path(profile_name)
        return ProfileInfo(
            name=profile_name,
            config_path=config_path,
            env_path=self.get_env_path(profile_name),
            state_db_path=self.get_state_db_path(profile_name),
            skills_path=self.get_skills_path(profile_name),
            exists=config_path.exists(),
        )


# ── .env 读写 ───────────────────────────────────────────────────────────────


class EnvService:
    """读写 profile 的 ``.env`` 文件。"""

    def __init__(self, hermes_home: Path | None = None):
        self.profiles = ProfileService(hermes_home)

    def read_env(self, profile: str | None = None) -> dict[str, str]:
        return self._read_set_vars(self.profiles.get_env_path(profile))

    def read_raw(self, profile: str | None = None) -> str:
        path = self.profiles.get_env_path(profile)
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8")

    def write_env(self, profile: str | None, updates: dict[str, str | None]) -> None:
        path = self.profiles.get_env_path(profile)
        lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
        pending = dict(updates)
        new_lines: list[str] = []

        for line in lines:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                new_lines.append(line)
                continue
            key = stripped.split("=", 1)[0].strip()
            if key not in pending:
                new_lines.append(line)
                continue
            value = pending.pop(key)
            if value is not None:
                new_lines.append(f"{key}={value}")

        for key, value in pending.items():
            if value is not None:
                new_lines.append(f"{key}={value}")

        atomic_write_text(path, "\n".join(new_lines) + "\n")

    def set_env_var(self, profile: str | None, key: str, value: str) -> None:
        self.write_env(profile, {key: value})

    def delete_env_var(self, profile: str | None, key: str) -> None:
        self.write_env(profile, {key: None})

    @staticmethod
    def _read_set_vars(path: Path) -> dict[str, str]:
        if not path.exists():
            return {}
        result: dict[str, str] = {}
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            result[key.strip()] = value.strip()
        return result


# ── config.yaml 读写 ────────────────────────────────────────────────────────


class YamlService:
    def __init__(self, hermes_home: Path | None = None):
        self.profiles = ProfileService(hermes_home)
        self.yaml = YAML()
        self.yaml.preserve_quotes = True
        self.yaml.width = 4096

    def read_config(self, profile: str | None = None) -> dict[str, Any]:
        path = self.profiles.get_config_path(profile)
        if not path.exists():
            return {}
        with path.open("r", encoding="utf-8") as file_obj:
            return self.yaml.load(file_obj) or {}

    def read_raw(self, profile: str | None = None) -> str:
        path = self.profiles.get_config_path(profile)
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8")

    def read_section(self, profile: str | None, section: str) -> Any:
        config = self.read_config(profile)
        return config.get(section, {}) if isinstance(config, dict) else {}

    def list_sections(self, profile: str | None = None) -> list[str]:
        config = self.read_config(profile)
        return list(config.keys()) if isinstance(config, dict) else []

    def write_section(self, profile: str | None, section: str, data: Any) -> None:
        config = self.read_config(profile)
        config[section] = data
        self.write_config(profile, config)

    def write_config(self, profile: str | None, data: dict[str, Any]) -> None:
        path = self.profiles.get_config_path(profile)
        path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = path.with_suffix(path.suffix + ".lock")
        with lock_path.open("w", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            self._backup(path)
            content = self._dump_to_string(data)
            self.yaml.load(content)  # 写前校验
            atomic_write_text(path, content)
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def write_raw(self, profile: str | None, content: str) -> None:
        path = self.profiles.get_config_path(profile)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.yaml.load(content or "{}\n")
        self._backup(path)
        atomic_write_text(path, content)

    def _dump_to_string(self, data: dict[str, Any]) -> str:
        buffer = io.StringIO()
        self.yaml.dump(data, buffer)
        return buffer.getvalue()

    def _backup(self, path: Path) -> None:
        if not path.exists():
            return
        backup_path = path.with_name(f"{path.name}.{int(time.time())}.bak")
        shutil.copy2(path, backup_path)
        backups = sorted(
            path.parent.glob(f"{path.name}.*.bak"),
            key=lambda item: item.stat().st_mtime,
        )
        for old_backup in backups[:-5]:
            old_backup.unlink(missing_ok=True)


# ── Skills 读写 ─────────────────────────────────────────────────────────────

SKILL_SOURCE_BUILTIN = "builtin"
SKILL_SOURCE_HUB = "hub"
SKILL_SOURCE_LOCAL = "local"
SKILL_SOURCE_EXTERNAL = "external"
SKILL_SOURCE_MODIFIED = "modified"

# Origin：按 source 派生的语义分类（不依赖本机作者签名，保证跨机器一致）。
SKILL_ORIGIN_LOCAL = "local"
SKILL_ORIGIN_MODIFIED = "modified"
SKILL_ORIGIN_COMMUNITY = "community"
SKILL_ORIGIN_OFFICIAL = "official"
SKILL_ORIGIN_UNKNOWN = "unknown"


def _derive_origin(source: str) -> str:
    """按 source 给 skill 分类（不依赖 author 签名）。"""
    src = (source or "").lower()
    if src == SKILL_SOURCE_MODIFIED:
        return SKILL_ORIGIN_MODIFIED
    if src == SKILL_SOURCE_BUILTIN:
        return SKILL_ORIGIN_OFFICIAL
    if src in (SKILL_SOURCE_HUB, SKILL_SOURCE_EXTERNAL, "skills.sh", "community"):
        return SKILL_ORIGIN_COMMUNITY
    if src == SKILL_SOURCE_LOCAL:
        return SKILL_ORIGIN_LOCAL
    return SKILL_ORIGIN_UNKNOWN


def _read_manifest(manifest_path: Path) -> dict[str, str]:
    """读取 .bundled_manifest，返回 {name: md5_hash}。"""
    if not manifest_path.exists():
        return {}
    result: dict[str, str] = {}
    for line in manifest_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        name, hash_val = line.split(":", 1)
        result[name.strip()] = hash_val.strip()
    return result


def _md5_of(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def _detect_source(
    name: str,
    skill_path: Path,
    skills_base: Path,
    bundled: dict[str, str],
    external_dirs: list[Path],
    webui_managed: set[str] | None = None,
) -> str:
    """判定 skill 来源：builtin, modified, hub, local, external。"""
    for ext_dir in external_dirs:
        if ext_dir in skill_path.parents:
            return SKILL_SOURCE_EXTERNAL

    hub_dir = skills_base / "hub"
    if hub_dir.exists() and hub_dir in skill_path.parents:
        return SKILL_SOURCE_HUB

    if webui_managed and name in webui_managed:
        return SKILL_SOURCE_HUB

    if name in bundled:
        sk_file = skill_path / "SKILL.md" if skill_path.is_dir() else skill_path
        if sk_file.exists() and _md5_of(sk_file) != bundled[name]:
            return SKILL_SOURCE_MODIFIED
        return SKILL_SOURCE_BUILTIN

    return SKILL_SOURCE_LOCAL


@dataclass(frozen=True)
class SkillSummary:
    name: str
    category: str
    path: str
    description: str | None
    enabled: bool
    source: str = SKILL_SOURCE_LOCAL
    author: str | None = None
    origin: str = SKILL_ORIGIN_UNKNOWN


class SkillService:
    def __init__(self):
        self.profiles = ProfileService()
        self.yaml = YAML(typ="safe")

    _logger = logging.getLogger(__name__)

    # ── listing ────────────────────────────────────────────

    def list_skills(self, profile: str | None = None) -> list[dict]:
        base = self.profiles.get_skills_path(profile)
        if not base.exists():
            return []

        bundled = _read_manifest(base / ".bundled_manifest")
        webui_managed = self._read_webui_managed(base)
        external_dirs = [
            Path(d).expanduser().resolve() for d in self.get_external_dirs(profile) if d
        ]

        skills: list[dict] = []
        for skill_file in sorted(base.glob("**/SKILL.md")):
            relative = skill_file.relative_to(base)
            category = relative.parts[0] if len(relative.parts) > 2 else "general"
            name = relative.parts[-2]
            frontmatter, _ = self._parse(skill_file.read_text(encoding="utf-8"))
            skill_name = str(frontmatter.get("name") or name)

            enabled = not (skill_file.parent / ".disabled").exists()
            source = _detect_source(
                skill_name, skill_file.parent, base, bundled, external_dirs, webui_managed
            )
            author_raw = frontmatter.get("author")
            author = str(author_raw).strip() if author_raw else None
            origin = _derive_origin(source)

            skills.append(
                SkillSummary(
                    name=skill_name,
                    category=category,
                    path=str(relative),
                    description=frontmatter.get("description"),
                    enabled=enabled,
                    source=source,
                    author=author,
                    origin=origin,
                ).__dict__
            )
        return skills

    # ── read ───────────────────────────────────────────────

    def read_skill(self, profile: str | None, name: str) -> dict:
        path = self._find_skill(profile, name)
        content = path.read_text(encoding="utf-8")
        frontmatter, body = self._parse(content)
        return {
            "name": name,
            "path": str(path),
            "frontmatter": frontmatter,
            "body": body,
            "content": content,
        }

    # ── external dirs（只读：供来源探测）────────────────────

    def get_external_dirs(self, profile: str | None) -> list[str]:
        config = self._load_config(profile)
        ext = config.get("skills", {}).get("external_dirs", [])
        return [str(d) for d in ext] if isinstance(ext, list) else []

    # ── internals ──────────────────────────────────────────

    def _skill_path(self, profile: str | None, name: str) -> Path:
        safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "-", name).strip("-") or "skill"
        return self.profiles.get_skills_path(profile) / "custom" / safe_name / "SKILL.md"

    def _find_skill(self, profile: str | None, name: str) -> Path:
        base = self.profiles.get_skills_path(profile)
        candidate = self._skill_path(profile, name)
        if candidate.exists():
            return candidate
        for skill_file in base.glob("**/SKILL.md"):
            if skill_file.parent.name == name:
                return skill_file
            frontmatter, _ = self._parse(skill_file.read_text(encoding="utf-8"))
            if frontmatter.get("name") == name:
                return skill_file
        raise FileNotFoundError(name)

    def _parse(self, content: str) -> tuple[dict, str]:
        if not content.startswith("---\n"):
            return {}, content
        _, frontmatter_text, body = content.split("---", 2)
        try:
            return self.yaml.load(frontmatter_text) or {}, body.lstrip("\n")
        except Exception as exc:
            self._logger.warning("_parse: YAML parse failed: %s", exc)
            return {}, body.lstrip("\n")

    def _load_config(self, profile: str | None) -> dict:
        path = self.profiles.get_config_path(profile)
        if not path.exists():
            return {}
        return self.yaml.load(path.read_text(encoding="utf-8")) or {}

    @staticmethod
    def _read_webui_managed(base: Path) -> set[str]:
        path = base / ".webui-managed-skills.json"
        if not path.exists():
            return set()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return set()
        return set(data.keys()) if isinstance(data, dict) else set()