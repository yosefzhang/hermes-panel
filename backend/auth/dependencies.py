from __future__ import annotations

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jwt import InvalidTokenError

from backend.auth.service import AuthService
from backend.db.models import User


oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


def get_auth_service(request: Request) -> AuthService:
    return AuthService(request.app.state.settings)


def get_current_user(
    token: str = Depends(oauth2_scheme),
    auth_service: AuthService = Depends(get_auth_service),
) -> User:
    try:
        user = auth_service.user_from_token(token)
    except InvalidTokenError as error:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from error
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    return user


def ensure_profile_access(user: User, profile: str | None) -> str:
    profile_name = profile or "default"
    if user.role == "admin" or "*" in user.profiles or profile_name in user.profiles:
        return profile_name
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No access to this profile")