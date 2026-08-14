from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request

from backend.api.config import yaml_service
from backend.auth.dependencies import ensure_profile_access, get_current_user
from backend.db.models import User
from backend.services.profile_service import ProfileService
from backend.services.yaml_service import YamlService


router = APIRouter(prefix="/memory", tags=["memory"])


def profile_service(request: Request) -> ProfileService:
    return ProfileService()


@router.get("")
def get_memory(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
    profiles: ProfileService = Depends(profile_service),
):
    profile_name = ensure_profile_access(user, profile)
    root = profiles.profile_root(profile_name)
    memories = {}
    for filename in ("MEMORY.md", "USER.md"):
        path = root / "memories" / filename
        if path.exists():
            content = path.read_text(encoding="utf-8")
            memories[filename.removesuffix(".md")] = content

    return {
        "config": service.read_section(profile_name, "memory"),
        "memories": memories,
    }


@router.put("")
def update_memory(
    payload: dict[str, Any],
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    service.write_section(ensure_profile_access(user, profile), "memory", payload)
    return {"ok": True}
