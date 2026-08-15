from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from backend.auth.dependencies import get_current_user
from backend.db.models import User
from backend.services.profile_service import ProfileService


router = APIRouter(prefix="/profiles", tags=["profiles"])


def profile_service(request: Request) -> ProfileService:
    return ProfileService()


class ProfileInfoResponse(BaseModel):
    name: str
    config_path: str
    env_path: str
    state_db_path: str
    skills_path: str
    exists: bool


@router.get("")
async def list_profiles(
    user: User = Depends(get_current_user),
    service: ProfileService = Depends(profile_service),
):
    profiles = service.list_profiles()
    if user.role != "admin" and "*" not in user.profiles:
        profiles = [profile for profile in profiles if profile in user.profiles]
    return {"profiles": profiles}


@router.get("/{name}", response_model=ProfileInfoResponse)
async def get_profile(
    name: str,
    user: User = Depends(get_current_user),
    service: ProfileService = Depends(profile_service),
):
    if user.role != "admin" and "*" not in user.profiles and name not in user.profiles:
        raise HTTPException(status_code=403, detail="No access to this profile")
    info = service.get_profile_info(name)
    return ProfileInfoResponse(
        name=info.name,
        config_path=str(info.config_path),
        env_path=str(info.env_path),
        state_db_path=str(info.state_db_path),
        skills_path=str(info.skills_path),
        exists=info.exists,
    )
