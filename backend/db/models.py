from __future__ import annotations

import json
from dataclasses import dataclass


@dataclass(frozen=True)
class Profile:
    id: int
    host: str | None
    username: str | None
    ip: str | None
    profile_name: str
    path: str | None
    gateway_status: str | None
    session_count: int
    total_tokens: int
    total_input_tokens: int
    total_output_tokens: int
    cache_hit_rate: float
    model_top5: list[dict]
    provider_top5: list[dict]
    daily_tokens: list[dict]
    current_config_version: int | None
    latest_config_version: int | None
    memory_available: bool | None
    memory_provider: str | None
    memory_endpoint: str | None
    memory_agent: str | None
    updated_at: float

    @property
    def server_id(self) -> str:
        return f"{self.host or ''}|{self.username or ''}|{self.ip or ''}"

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "server_id": self.server_id,
            "host": self.host,
            "username": self.username,
            "ip": self.ip,
            "profile_name": self.profile_name,
            "path": self.path,
            "gateway_status": self.gateway_status,
            "session_count": self.session_count,
            "total_tokens": self.total_tokens,
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
            "cache_hit_rate": self.cache_hit_rate,
            "model_top5": self.model_top5,
            "provider_top5": self.provider_top5,
            "daily_tokens": self.daily_tokens,
            "current_config_version": self.current_config_version,
            "latest_config_version": self.latest_config_version,
            "memory_available": self.memory_available,
            "memory_provider": self.memory_provider,
            "memory_endpoint": self.memory_endpoint,
            "memory_agent": self.memory_agent,
            "updated_at": self.updated_at,
        }


# Backwards-compatible alias for existing imports.
ProfileStats = Profile


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