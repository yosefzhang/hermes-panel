from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


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
    def __init__(self, hermes_home: str | Path | None = None):
        self.hermes_home = Path(hermes_home or Path.home() / ".hermes").expanduser()

    def normalize_profile(self, profile: str | None) -> str:
        return profile or DEFAULT_PROFILE

    def profile_root(self, profile: str | None) -> Path:
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
        profiles = [DEFAULT_PROFILE]
        profiles_dir = self.hermes_home / "profiles"
        if not profiles_dir.is_dir():
            return profiles

        discovered = sorted(
            child.name
            for child in profiles_dir.iterdir()
            if child.is_dir() and (child / "config.yaml").exists()
        )
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