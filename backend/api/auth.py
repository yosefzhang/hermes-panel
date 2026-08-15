from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from backend.auth.dependencies import get_auth_service, get_current_user
from backend.auth.models import LoginRequest, TokenResponse
from backend.auth.service import AuthService
from backend.db.models import User


router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
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


@router.get("/me")
async def me(user: User = Depends(get_current_user)):
    return {"user": user.public_dict()}


@router.post("/logout")
async def logout():
    return {"ok": True}
