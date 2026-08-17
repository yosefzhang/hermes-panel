"""Profile discovery and management.

The panel discovers profiles by scanning ~/.hermes/profiles/ directory.
It uses the Panel-provided Hermes data directory.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


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
    """Discover and manage Hermes profiles.

    The panel automatically discovers ~/.hermes and profiles under it.
    The Hermes data directory is supplied explicitly by the Panel.
    """

    def __init__(self, hermes_home: Path | None = None):
        # Always use the current user's base Hermes directory unless explicitly
        # The explicit path also keeps tests isolated from the user's data.
        self.hermes_home = hermes_home or (Path.home() / ".hermes")

    def normalize_profile(self, profile: str | None) -> str:
        return profile or DEFAULT_PROFILE

    def profile_root(self, profile: str | None) -> Path:
        """Get the root directory for a profile."""
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
        """Discover all profiles under ~/.hermes/profiles/."""
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

    def get_config_version(self, profile: str | None) -> int | None:
        """Return the ``_config_version`` stamped in the profile's config.yaml.

        Matches the ``current`` half of hermes' ``check_config_version()``:
        read the raw on-disk YAML (no DEFAULT_CONFIG merge) so a config
        with no version key is reported as legacy (``None``) rather than
        inheriting the latest default version.
        """
        from ruamel.yaml import YAML

        config_path = self.get_config_path(self.normalize_profile(profile))
        if not config_path.exists():
            return None
        try:
            with open(config_path, encoding="utf-8") as f:
                raw = YAML(typ="safe").load(f) or {}
        except Exception:
            return None
        if not isinstance(raw, dict):
            return None
        value = raw.get("_config_version")
        try:
            version = int(value)
        except (TypeError, ValueError):
            return None
        return max(version, 0)
