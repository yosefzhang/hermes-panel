"""认证、授权与用户管理。

包含请求模型、AuthService 以及 FastAPI 依赖（当前用户 / 管理员 / profile 权限）。
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jwt import InvalidTokenError
from pydantic import BaseModel, Field

from backend.config import Settings
from backend.store import JsonStore, User, hash_password, next_id, verify_password

# 种子管理员账号（settings.default_admin_username，默认 admin）不可删除，
# 否则全新安装可能把自己锁在系统外。


# ── 请求模型 ────────────────────────────────────────────────────────────────


class LoginRequest(BaseModel):
    username: str
    password: str


class UserCreate(BaseModel):
    username: str
    password: str
    role: str = Field(default="user", pattern="^(admin|user)$")
    profiles: list[str] = Field(default_factory=list)


class UserUpdate(BaseModel):
    username: str | None = None
    password: str | None = None
    role: str | None = Field(default=None, pattern="^(admin|user)$")
    profiles: list[str] | None = None


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict


# ── AuthService ─────────────────────────────────────────────────────────────


def _user_from_dict(d: dict) -> User:
    return User(
        id=int(d["id"]),
        username=d["username"],
        password_hash=d["password_hash"],
        role=d["role"],
        profiles=list(d.get("profiles") or []),
        created_at=float(d["created_at"]),
        updated_at=float(d["updated_at"]),
    )


class AuthService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.store = JsonStore(settings.data_dir)

    def authenticate(self, username: str, password: str) -> User | None:
        user = self.get_user_by_username(username)
        if not user or not verify_password(password, user.password_hash):
            return None
        return user

    def create_access_token(self, user: User) -> str:
        expires = datetime.now(timezone.utc) + timedelta(hours=self.settings.jwt_expires_hours)
        payload = {
            "sub": str(user.id),
            "username": user.username,
            "role": user.role,
            "profiles": user.profiles,
            "exp": expires,
        }
        return jwt.encode(payload, self.settings.jwt_secret, algorithm=self.settings.jwt_algorithm)

    def user_from_token(self, token: str) -> User | None:
        payload = jwt.decode(token, self.settings.jwt_secret, algorithms=[self.settings.jwt_algorithm])
        return self.get_user(int(payload["sub"]))

    def get_user(self, user_id: int) -> User | None:
        for item in self.store.users.read():
            if int(item["id"]) == user_id:
                return _user_from_dict(item)
        return None

    def get_user_by_username(self, username: str) -> User | None:
        for item in self.store.users.read():
            if item["username"] == username:
                return _user_from_dict(item)
        return None

    def list_users(self) -> list[dict]:
        users = sorted(self.store.users.read(), key=lambda item: int(item["id"]))
        return [_user_from_dict(item).public_dict() for item in users]

    def create_user(self, payload: UserCreate) -> dict:
        now = time.time()
        profiles = ["*"] if payload.role == "admin" else payload.profiles

        def _do_create(items: list[dict]) -> None:
            if any(item["username"] == payload.username for item in items):
                raise ValueError("username already exists")
            items.append(
                {
                    "id": next_id(items),
                    "username": payload.username,
                    "password_hash": hash_password(payload.password),
                    "role": payload.role,
                    "profiles": profiles,
                    "created_at": now,
                    "updated_at": now,
                }
            )

        try:
            self.store.users.mutate(_do_create)
        except ValueError as error:
            raise ValueError("username already exists") from error
        return self.get_user_by_username(payload.username).public_dict()

    def update_user(self, user_id: int, payload: UserUpdate) -> dict | None:
        user = self.get_user(user_id)
        if user is None:
            return None

        role = payload.role if payload.role is not None else user.role
        profiles = payload.profiles if payload.profiles is not None else user.profiles
        if role == "admin":
            profiles = ["*"]
        password_hash = hash_password(payload.password) if payload.password else None
        new_username = payload.username.strip() if payload.username is not None else None
        if new_username == "":
            raise ValueError("username cannot be empty")

        def _do_update(items: list[dict]) -> None:
            if new_username is not None and any(
                item["username"] == new_username and int(item["id"]) != user_id
                for item in items
            ):
                raise ValueError("username already exists")
            for item in items:
                if int(item["id"]) == user_id:
                    if new_username is not None:
                        item["username"] = new_username
                    item["role"] = role
                    item["profiles"] = profiles
                    item["updated_at"] = time.time()
                    if password_hash is not None:
                        item["password_hash"] = password_hash
                    return

        self.store.users.mutate(_do_update)
        return self.get_user(user_id).public_dict()

    def delete_user(self, user_id: int) -> bool:
        deleted = False

        def _do_delete(items: list[dict]) -> None:
            nonlocal deleted
            for idx, item in enumerate(items):
                if int(item["id"]) == user_id and item["username"] != self.settings.default_admin_username:
                    del items[idx]
                    deleted = True
                    return

        self.store.users.mutate(_do_delete)
        return deleted


# ── FastAPI 依赖 ────────────────────────────────────────────────────────────


oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


def get_auth_service(request: Request) -> AuthService:
    return AuthService(request.app.state.settings)


async def get_current_user(
    token: Annotated[str, Depends(oauth2_scheme)],
    auth_service: Annotated[AuthService, Depends(get_auth_service)],
) -> User:
    try:
        user = auth_service.user_from_token(token)
    except InvalidTokenError as error:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from error
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    return user


async def require_admin(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    return user


def ensure_profile_access(user: User, profile: str | None) -> str:
    profile_name = profile or "default"
    if user.role == "admin" or "*" in user.profiles or profile_name in user.profiles:
        return profile_name
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No access to this profile")


def get_accessible_profiles(user: User, all_profiles: list[str]) -> list[str]:
    """把 *all_profiles* 过滤为当前用户有权查看的部分。"""
    if user.role == "admin" or "*" in user.profiles:
        return all_profiles
    return [p for p in all_profiles if p in user.profiles]