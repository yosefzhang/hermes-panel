from __future__ import annotations

from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, status

from backend.auth.dependencies import get_auth_service, get_current_user, require_admin
from backend.auth.models import UserCreate, UserUpdate
from backend.auth.service import AuthService
from backend.db.models import User


router = APIRouter(prefix="/users", tags=["users"])


class PasswordChange(BaseModel):
    new_password: str


@router.get("")
def list_users(
    current_user: User = Depends(get_current_user),
    auth_service: AuthService = Depends(get_auth_service),
):
    """获取用户列表：admin 可以看到所有用户，普通用户只能看到自己"""
    if current_user.role == "admin":
        return {"users": auth_service.list_users()}
    else:
        # 普通用户只能看到自己
        return {"users": [auth_service.get_user(current_user.id).public_dict()]}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreate,
    _: User = Depends(require_admin),
    auth_service: AuthService = Depends(get_auth_service),
):
    try:
        return auth_service.create_user(payload)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.put("/{user_id}")
def update_user(
    user_id: int,
    payload: UserUpdate,
    _: User = Depends(require_admin),
    auth_service: AuthService = Depends(get_auth_service),
):
    user = auth_service.update_user(user_id, payload)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.delete("/{user_id}")
def delete_user(
    user_id: int,
    _: User = Depends(require_admin),
    auth_service: AuthService = Depends(get_auth_service),
):
    if not auth_service.delete_user(user_id):
        raise HTTPException(status_code=404, detail="User not found")
    return {"ok": True}


@router.put("/{user_id}/password")
def change_password(
    user_id: int,
    payload: PasswordChange,
    current_user: User = Depends(get_current_user),
    auth_service: AuthService = Depends(get_auth_service),
):
    """修改密码：admin 可以修改任何用户的密码，普通用户只能修改自己的密码"""
    if current_user.role != "admin" and current_user.id != user_id:
        raise HTTPException(status_code=403, detail="Permission denied")
    
    if not payload.new_password or len(payload.new_password) < 3:
        raise HTTPException(status_code=400, detail="Password must be at least 3 characters")
    
    user = auth_service.update_user(user_id, UserUpdate(password=payload.new_password))
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return {"ok": True}