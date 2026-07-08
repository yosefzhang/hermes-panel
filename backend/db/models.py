from __future__ import annotations

from dataclasses import dataclass


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