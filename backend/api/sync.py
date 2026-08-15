"""Cross-panel data sync API.

Any panel can receive sync payloads from other panels.  The receiving panel
stores the incoming profile_stats under the sender's server_id and host_info
under the sender's host, username and IP combination.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from backend.auth.dependencies import require_admin
from backend.config import Settings, get_settings, update_config_file
from backend.db.models import User
from backend.services.sync_service import SyncService, get_receive_status, get_send_status, set_receive_enabled, set_send_enabled

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
    """Persist sync configuration to the panel's config.yaml file."""
    app_settings: Settings = request.app.state.settings
    update_config_file({
        "sync": {
            "enabled": body.enabled,
            "receive_enabled": body.receive_enabled,
            "target_url": body.target_url,
            "token": body.token,
            "interval": body.interval,
        }
    })

    set_receive_enabled(body.receive_enabled)
    set_send_enabled(body.enabled)

    # Update in-memory settings immediately.
    app_settings.sync_enabled = body.enabled
    app_settings.sync_receive_enabled = body.receive_enabled
    app_settings.sync_target_url = body.target_url
    app_settings.sync_token = body.token
    app_settings.sync_interval = body.interval

    return {"ok": True}


@router.get("/status")
async def get_sync_status(
    request: Request,
    user: User = Depends(require_admin),
):
    """Return runtime sync status, including receive-sync process state."""
    settings = get_settings()
    status = get_receive_status()
    status["send"] = get_send_status()
    # Derive the local receive endpoint URL from the request so the UI can
    # show senders where to POST.
    scheme = request.url.scheme
    host = request.headers.get("host", f"{settings.host}:{settings.port}")
    status["receive_url"] = f"{scheme}://{host}/api/v1/sync/"
    status["port"] = settings.port
    return status


@router.post("/")
async def receive_sync(request: Request, payload: dict):
    """Receive profile_stats and host_info from another hermes-panel.

    Authentication: the sender provides the shared sync token via the
    ``Authorization: Bearer <token>`` header.  This is a machine-to-machine
    endpoint, so we verify the sync token directly rather than requiring a
    JWT (which only the panel's own UI users possess).
    """
    settings = get_settings()
    if not settings.sync_receive_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="接收同步未启用",
        )
    # Verify the shared sync token.
    expected_token = settings.sync_token
    if expected_token:
        auth_header = request.headers.get("Authorization", "")
        received_token = ""
        if auth_header.startswith("Bearer "):
            received_token = auth_header[7:]
        if received_token != expected_token:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="无效的同步凭证",
            )
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


@router.post("/push")
async def trigger_push(request: Request, user: User = Depends(require_admin)):
    """Trigger an immediate sync push to the target panel."""
    settings: Settings = request.app.state.settings
    if not settings.sync_enabled or not settings.sync_target_url:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="发送同步未启用或未配置目标地址",
        )
    service = SyncService(settings)
    result = await asyncio.to_thread(service.push)
    from backend.services.sync_service import record_push_result
    record_push_result(result.get("ok", False), result.get("message"))
    if not result.get("ok"):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=result.get("message", "推送失败"),
        )
    return result
