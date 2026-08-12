from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

# Make the local Hermes Agent checkout importable so we can reuse its
# env-var catalog and channel metadata.  This is a soft dependency: if
# hermes-agent isn't installed we fall back to a minimal hard-coded
# catalog so the env UI still works.
hermes_agent_path = Path.home() / ".hermes" / "hermes-agent"
if hermes_agent_path.exists() and str(hermes_agent_path) not in sys.path:
    sys.path.insert(0, str(hermes_agent_path))

ENV_CATALOG: dict[str, dict[str, Any]] = {}
CHANNEL_MANAGED_KEYS: set[str] = set()
try:
    from hermes_cli.config import OPTIONAL_ENV_VARS  # type: ignore[import-not-found]
    from hermes_cli.web_server import (  # type: ignore[import-not-found]
        _catalog_provider_env_metadata,
        _channel_managed_env_keys,
    )

    for key, info in OPTIONAL_ENV_VARS.items():
        ENV_CATALOG[key] = {
            "description": info.get("description", ""),
            "url": info.get("url"),
            "category": info.get("category", "custom"),
            "is_password": info.get("password", False),
            "tools": info.get("tools", []),
            "advanced": info.get("advanced", False),
        }

    catalog_meta = _catalog_provider_env_metadata()
    for key, meta in catalog_meta.items():
        ENV_CATALOG[key] = {
            "description": meta.get("description", ""),
            "url": meta.get("url"),
            "category": meta.get("category", "provider"),
            "is_password": meta.get("is_password", False),
            "tools": [],
            "advanced": meta.get("advanced", False),
        }

    CHANNEL_MANAGED_KEYS = set(_channel_managed_env_keys())

    print(
        f"✓ Loaded {len(ENV_CATALOG)} env vars from hermes-agent catalog",
        file=sys.stderr,
    )
    print(
        f"✓ Channel-managed keys: {len(CHANNEL_MANAGED_KEYS)}",
        file=sys.stderr,
    )
except ImportError as exc:
    print(f"✗ Failed to import hermes-agent catalog: {exc}", file=sys.stderr)
    ENV_CATALOG = {
        "ANTHROPIC_API_KEY": {
            "description": "Anthropic API Key",
            "url": "https://console.anthropic.com/",
            "category": "provider",
            "is_password": True,
            "tools": [],
            "advanced": False,
        },
        "OPENAI_API_KEY": {
            "description": "OpenAI API Key",
            "url": "https://platform.openai.com/api-keys",
            "category": "provider",
            "is_password": True,
            "tools": [],
            "advanced": False,
        },
    }
    CHANNEL_MANAGED_KEYS = set()

from .atomic_io import atomic_write_text
from .profile_service import ProfileService


class EnvService:
    def __init__(self, hermes_home: Path | None = None):
        self.profiles = ProfileService(hermes_home)

    def read_env_detailed(self, profile: str | None = None) -> dict[str, dict[str, Any]]:
        """Return catalog-enriched env var information for *profile*."""
        path = self.profiles.get_env_path(profile)
        set_vars: dict[str, str] = self._read_set_vars(path)

        result: dict[str, dict[str, Any]] = {}
        for key, catalog_info in ENV_CATALOG.items():
            is_set = key in set_vars
            result[key] = {
                "is_set": is_set,
                "value": set_vars[key] if is_set else None,
                "description": catalog_info["description"],
                "url": catalog_info["url"],
                "category": catalog_info["category"],
                "is_password": catalog_info["is_password"],
                "tools": catalog_info["tools"],
                "advanced": catalog_info["advanced"],
                "channel_managed": key in CHANNEL_MANAGED_KEYS,
                "custom": False,
            }

        # Surface user-defined vars that aren't in the catalog (excluding
        # anything owned by the Channels page).
        for key, value in set_vars.items():
            if key in result or key in CHANNEL_MANAGED_KEYS:
                continue
            result[key] = {
                "is_set": True,
                "value": value,
                "description": "自定义环境变量",
                "url": None,
                "category": "custom",
                "is_password": False,
                "tools": [],
                "advanced": False,
                "channel_managed": False,
                "custom": True,
            }

        return result

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
