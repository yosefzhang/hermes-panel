from __future__ import annotations

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    username: str
    password: str


class UserCreate(BaseModel):
    username: str
    password: str
    role: str = Field(default="user", pattern="^(admin|user)$")
    profiles: list[str] = Field(default_factory=list)


class UserUpdate(BaseModel):
    password: str | None = None
    role: str | None = Field(default=None, pattern="^(admin|user)$")
    profiles: list[str] | None = None


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict