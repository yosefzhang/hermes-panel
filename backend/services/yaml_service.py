from __future__ import annotations

import fcntl
import io
import shutil
import time
from pathlib import Path
from typing import Any

from ruamel.yaml import YAML

from .cli_utils import atomic_write_text
from .profile_service import ProfileService


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
            self.yaml.load(content)  # validate before writing
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
