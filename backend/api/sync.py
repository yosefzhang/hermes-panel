"""Cross-panel data sync API.

Any panel can receive sync payloads from other panels.  The receiving panel
stores the incoming profile_stats under the sender's server_id and host_info
under the sender's host, username and IP combination.
"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from backend.auth.dependencies import require_admin
from backend.config import Settings, get_settings, update_config_file
from backend.db.models import User
from backend.services.sync_service import SyncService, ensure_receive_token, get_receive_status, get_send_status, set_receive_enabled, set_send_enabled

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sync", tags=["sync"])


class SyncSettingsOut(BaseModel):
    enabled: bool
    receive_enabled: bool
    target_url: str | None
    send_token: str | None
    receive_token: str | None
    interval: int


class SyncSettingsIn(BaseModel):
    enabled: bool
    receive_enabled: bool
    target_url: str | None = Field(default=None)
    send_token: str | None = Field(default=None)
    receive_token: str | None = Field(default=None)
    interval: int = Field(default=60, ge=10)


class VerifyTargetIn(BaseModel):
    target_url: str
    token: str | None = Field(default=None)


@router.get("/settings", response_model=SyncSettingsOut)
async def get_sync_settings(request: Request, user: User = Depends(require_admin)):
    """Return the current data sync configuration."""
    settings: Settings = request.app.state.settings
    return SyncSettingsOut(
        enabled=settings.sync_enabled,
        receive_enabled=settings.sync_receive_enabled,
        target_url=settings.sync_target_url,
        send_token=settings.sync_send_token,
        receive_token=settings.sync_receive_token,
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
            "send_token": body.send_token,
            "receive_token": body.receive_token,
            "interval": body.interval,
        }
    })

    set_receive_enabled(body.receive_enabled)
    set_send_enabled(body.enabled)

    # Update in-memory settings immediately.
    app_settings.sync_enabled = body.enabled
    app_settings.sync_receive_enabled = body.receive_enabled
    app_settings.sync_target_url = body.target_url
    app_settings.sync_send_token = body.send_token
    app_settings.sync_receive_token = body.receive_token
    app_settings.sync_interval = body.interval

    return {"ok": True}


@router.get("/status")
async def get_sync_status(
    request: Request,
    user: User = Depends(require_admin),
):
    """Return runtime sync status, including receive-sync process state."""
    settings: Settings = request.app.state.settings
    # Ensure a receive token exists (auto-generated and persisted if missing).
    ensure_receive_token(settings)
    status = get_receive_status()
    status["send"] = get_send_status()
    # Derive the local receive endpoint URL from the request so the UI can
    # show senders where to POST.
    scheme = request.url.scheme
    host = request.headers.get("host", f"{settings.host}:{settings.port}")
    status["receive_url"] = f"{scheme}://{host}/api/v1/sync/"
    status["port"] = settings.port
    # Surface the currently configured receive token so the receiving-side UI
    # can display it next to the usage instructions.
    status["receive_token"] = settings.sync_receive_token
    return status


@router.post("/")
async def receive_sync(request: Request):
    """Receive profile_stats and host_info from another panel or external system.

    Authentication: the sender provides the inbound receive token via the
    ``Authorization: Bearer <token>`` header.  This is a machine-to-machine
    endpoint, so we verify the receive token directly rather than requiring a
    JWT (which only the panel's own UI users possess).

    The body is read as raw bytes and JSON-parsed manually so that callers
    that omit ``Content-Type: application/json`` or send pre-compact JSON
    still work, and so we can return a clear 400 instead of FastAPI's 422.
    """
    settings: Settings = request.app.state.settings
    if not settings.sync_receive_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="接收同步未启用",
        )
    # Verify the inbound receive token.
    expected_token = settings.sync_receive_token
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

    body = await request.body()
    if not body:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="请求体为空",
        )
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="请求体不是合法的 JSON",
        )
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="请求体必须是 JSON 对象",
        )

    service = SyncService(settings)
    try:
        result = service.ingest(payload)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    logger.info(
        "Sync received: source=%s profiles=%d hosts=%d",
        request.headers.get("user-agent", "-"),
        len(payload.get("profiles", [])),
        len(payload.get("hosts", [])),
    )
    return result


@router.post("/verify")
async def verify_target(
    request: Request,
    body: VerifyTargetIn,
    user: User = Depends(require_admin),
):
    """Verify that a target panel is reachable and returns a valid health response."""
    settings: Settings = request.app.state.settings
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

