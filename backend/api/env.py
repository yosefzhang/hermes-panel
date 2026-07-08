"""Environment variable management: read/edit `.env` for a profile."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from backend.auth.dependencies import ensure_profile_access, get_current_user
from backend.db.models import User
from backend.services.env_service import EnvService


router = APIRouter(prefix="/env", tags=["env"])


def env_service(request: Request) -> EnvService:
    return EnvService(request.app.state.settings.hermes_home)


class EnvBatchPayload(BaseModel):
    entries: list[dict[str, str | None]]


@router.get("")
async def get_env_detailed(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: EnvService = Depends(env_service),
):
    """Catalog-enriched env vars for the profile."""
    ensure_profile_access(user, profile)
    return service.read_env_detailed(profile)


@router.get("/plain")
async def get_env_plain(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: EnvService = Depends(env_service),
):
    """Flat `KEY=value` dict, useful for scripts and quick checks."""
    ensure_profile_access(user, profile)
    return service.read_env(profile)


@router.put("/batch")
async def batch_update_env(
    payload: EnvBatchPayload,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: EnvService = Depends(env_service),
):
    """Apply multiple set/delete operations atomically.

    Each entry must have `key` and `value`.  A `value` of `null` removes
    the key (or no-ops if it doesn't exist).
    """
    ensure_profile_access(user, profile)
    updates: dict[str, str | None] = {}
    for entry in payload.entries:
        key = entry.get("key")
        if not key:
            raise HTTPException(status_code=400, detail="entries[].key is required")
        if "value" not in entry:
            raise HTTPException(status_code=400, detail="entries[].value is required (use null to delete)")
        updates[key] = entry["value"]

    service.write_env(profile, updates)
    return {"ok": True, "updated": len(updates)}


@router.put("")
async def update_env(
    payload: dict[str, str],
    key: str = Query(...),
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: EnvService = Depends(env_service),
):
    ensure_profile_access(user, profile)
    if "value" not in payload:
        raise HTTPException(status_code=400, detail="value is required")
    service.set_env_var(profile, key, payload["value"])
    return {"ok": True}


@router.delete("")
async def delete_env(
    key: str = Query(...),
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: EnvService = Depends(env_service),
):
    ensure_profile_access(user, profile)
    service.delete_env_var(profile, key)
    return {"ok": True}
