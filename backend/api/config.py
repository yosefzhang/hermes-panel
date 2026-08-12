from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel

from backend.auth.dependencies import ensure_profile_access, get_current_user
from backend.db.models import User
from backend.services.yaml_service import YamlService


router = APIRouter(prefix="/config", tags=["config"])


class RawConfigUpdate(BaseModel):
    content: str


def yaml_service(request: Request) -> YamlService:
    return YamlService()


@router.get("")
def get_config(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    profile_name = ensure_profile_access(user, profile)
    return service.read_config(profile_name)


@router.get("/sections")
def list_sections(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    profile_name = ensure_profile_access(user, profile)
    return {"sections": service.list_sections(profile_name)}


@router.get("/sections/{name}")
def get_section(
    name: str,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    profile_name = ensure_profile_access(user, profile)
    return service.read_section(profile_name, name)


@router.put("/sections/{name}")
def update_section(
    name: str,
    payload: dict[str, Any],
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    profile_name = ensure_profile_access(user, profile)
    service.write_section(profile_name, name, payload)
    return {"ok": True, "section": name}


@router.get("/raw")
def get_raw_config(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    profile_name = ensure_profile_access(user, profile)
    return {"content": service.read_raw(profile_name)}


@router.put("/raw")
def update_raw_config(
    payload: RawConfigUpdate,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: YamlService = Depends(yaml_service),
):
    profile_name = ensure_profile_access(user, profile)
    service.write_raw(profile_name, payload.content)
    return {"ok": True}