"""Cross-panel data sync API.

Any panel can receive sync payloads from other panels.  The receiving panel
stores the incoming profile_stats under the sender's server_id and host_info
under the sender's host, username and IP combination.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from backend.auth.dependencies import require_admin
from backend.config import Settings, get_settings, update_env_file
from backend.db.models import User
from backend.services.sync_service import SyncService

router = APIRouter(prefix="/sync", tags=["sync"])


class SyncSettingsOut(BaseModel):
    enabled: bool
    receive_enabled: bool
    target_url: str | None
    token: str | None
    interval: int


class SyncSettingsIn(BaseModel):
    enabled: bool
    receive_enabled: bool
    target_url: str | None = Field(default=None)
    token: str | None = Field(default=None)
    interval: int = Field(default=60, ge=10)


class VerifyTargetIn(BaseModel):
    target_url: str
    token: str | None = Field(default=None)


@router.get("/settings", response_model=SyncSettingsOut)
async def get_sync_settings(user: User = Depends(require_admin)):
    """Return the current data sync configuration."""
    settings = get_settings()
    return SyncSettingsOut(
        enabled=settings.sync_enabled,
        receive_enabled=settings.sync_receive_enabled,
        target_url=settings.sync_target_url,
        token=settings.sync_token,
        interval=settings.sync_interval,
    )


@router.put("/settings")
async def update_sync_settings(
    request: Request,
    body: SyncSettingsIn,
    user: User = Depends(require_admin),
):
    """Persist sync configuration to the panel's .env file."""
    app_settings: Settings = request.app.state.settings
    updates = {
        "SYNC_ENABLED": "true" if body.enabled else "false",
        "SYNC_RECEIVE_ENABLED": "true" if body.receive_enabled else "false",
        "SYNC_TARGET_URL": body.target_url or None,
        "SYNC_TOKEN": body.token or None,
        "SYNC_INTERVAL": str(body.interval),
    }
    update_env_file(updates)

    # Update in-memory settings immediately.
    app_settings.sync_enabled = body.enabled
    app_settings.sync_receive_enabled = body.receive_enabled
    app_settings.sync_target_url = body.target_url
    app_settings.sync_token = body.token
    app_settings.sync_interval = body.interval

    return {"ok": True}


@router.post("/")
async def receive_sync(payload: dict, user: User = Depends(require_admin)):
    """Receive profile_stats and host_info from another hermes-panel."""
    settings = get_settings()
    service = SyncService(settings)
    try:
        result = service.ingest(payload)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return result


@router.post("/verify")
async def verify_target(
    body: VerifyTargetIn,
    user: User = Depends(require_admin),
):
    """Verify that a target panel is reachable and returns a valid health response."""
    settings = get_settings()
    service = SyncService(settings)
    result = service.verify_target(body.target_url, body.token)
    if not result.get("ok"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=result.get("message", "verification failed"),
        )
    return result
