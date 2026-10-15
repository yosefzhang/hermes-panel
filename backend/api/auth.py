"""认证、用户管理与 Token 用量 API。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel

from backend.auth import (
    AuthService,
    LoginRequest,
    TokenResponse,
    UserCreate,
    UserUpdate,
    ensure_profile_access,
    get_auth_service,
    get_current_user,
    require_admin,
)
from backend.services.system import StateReader
from backend.store import User


# ── /auth ───────────────────────────────────────────────────────────────────

auth_router = APIRouter(prefix="/auth", tags=["auth"])


@auth_router.post("/login", response_model=TokenResponse)
async def login(
    payload: LoginRequest,
    auth_service: AuthService = Depends(get_auth_service),
):
    user = auth_service.authenticate(payload.username, payload.password)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    return {
        "access_token": auth_service.create_access_token(user),
        "user": user.public_dict(),
    }


@auth_router.get("/me")
async def me(user: User = Depends(get_current_user)):
    return {"user": user.public_dict()}


@auth_router.post("/logout")
async def logout():
    return {"ok": True}


# ── /users ──────────────────────────────────────────────────────────────────

users_router = APIRouter(prefix="/users", tags=["users"])


class PasswordChange(BaseModel):
    new_password: str


@users_router.get("")
def list_users(
    current_user: User = Depends(get_current_user),
    auth_service: AuthService = Depends(get_auth_service),
):
    """获取用户列表：admin 可以看到所有用户，普通用户只能看到自己"""
    if current_user.role == "admin":
        return {"users": auth_service.list_users()}
    return {"users": [auth_service.get_user(current_user.id).public_dict()]}


@users_router.post("", status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreate,
    _: User = Depends(require_admin),
    auth_service: AuthService = Depends(get_auth_service),
):
    try:
        return auth_service.create_user(payload)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@users_router.put("/{user_id}")
def update_user(
    user_id: int,
    payload: UserUpdate,
    _: User = Depends(require_admin),
    auth_service: AuthService = Depends(get_auth_service),
):
    """修改用户信息（含用户名、密码、角色、profiles），仅 admin 有权限。"""
    try:
        user = auth_service.update_user(user_id, payload)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@users_router.delete("/{user_id}")
def delete_user(
    user_id: int,
    _: User = Depends(require_admin),
    auth_service: AuthService = Depends(get_auth_service),
):
    if not auth_service.delete_user(user_id):
        raise HTTPException(status_code=404, detail="User not found")
    return {"ok": True}


@users_router.put("/{user_id}/password")
def change_password(
    user_id: int,
    payload: PasswordChange,
    _: User = Depends(require_admin),
    auth_service: AuthService = Depends(get_auth_service),
):
    """修改密码：仅 admin 角色的账号可修改（自己或其他用户）。"""
    if not payload.new_password or len(payload.new_password) < 3:
        raise HTTPException(status_code=400, detail="Password must be at least 3 characters")

    user = auth_service.update_user(user_id, UserUpdate(password=payload.new_password))
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return {"ok": True}


# ── /tokens ─────────────────────────────────────────────────────────────────

tokens_router = APIRouter(prefix="/tokens", tags=["tokens"])


def state_reader(request: Request) -> StateReader:
    return StateReader(request.app.state.settings.hermes_home)


def period_to_days(period: str) -> int:
    if period.endswith("d") and period[:-1].isdigit():
        return max(1, int(period[:-1]))
    if period == "today":
        return 1
    return 30


@tokens_router.get("/summary")
def token_summary(
    period: str = "30d",
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    reader: StateReader = Depends(state_reader),
):
    return reader.aggregate_token_stats(ensure_profile_access(user, profile), period_to_days(period))


@tokens_router.get("/trend")
def token_trend(
    period: str = "30d",
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    reader: StateReader = Depends(state_reader),
):
    summary = reader.aggregate_token_stats(ensure_profile_access(user, profile), period_to_days(period))
    return {"series": summary["daily"]}


@tokens_router.get("/dashboard")
def token_dashboard(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    reader: StateReader = Depends(state_reader),
):
    return reader.get_dashboard_data(ensure_profile_access(user, profile))


@tokens_router.get("/models")
def token_models(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    reader: StateReader = Depends(state_reader),
):
    return {"models": reader.list_used_models(ensure_profile_access(user, profile))}