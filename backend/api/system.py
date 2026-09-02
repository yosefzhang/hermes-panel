"""审计日志、跨面板同步与聚合统计 API。"""
from __future__ import annotations

import asyncio
import json
import logging
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from backend.auth import get_current_user, require_admin
from backend.config import Settings, update_config_file
from backend.services.system import (
    ProfileStatsService,
    SyncService,
    ensure_receive_token,
    get_audit_logs,
    get_receive_status,
    get_send_status,
    set_receive_enabled,
    set_send_enabled,
)
from backend.store import User

logger = logging.getLogger(__name__)


# ── /system ─────────────────────────────────────────────────────────────────

system_router = APIRouter(prefix="/system", tags=["system"])


@system_router.get("/health")
def health():
    return {"status": "ok"}


# ── /audit-logs ─────────────────────────────────────────────────────────────

audit_router = APIRouter(prefix="/audit-logs", tags=["audit"])


@audit_router.get("")
def list_audit_logs(
    request: Request,
    limit: int = 100,
    offset: int = 0,
    action: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    _: User = Depends(require_admin),
):
    logs = get_audit_logs(
        request.app.state.settings,
        limit=max(1, min(limit, 1000)),
        offset=max(0, offset),
        action=action,
        target_type=target_type,
        target_id=target_id,
    )
    return {"logs": [log.to_dict() for log in logs]}


# ── /profiles/aggregated ────────────────────────────────────────────────────

profile_stats_router = APIRouter(prefix="/profiles/aggregated", tags=["profiles"])


def _stats_service(request: Request) -> ProfileStatsService:
    return ProfileStatsService(request.app.state.settings)


@profile_stats_router.get("")
def list_profile_stats(
    range: str = "all",
    user: User = Depends(get_current_user),
    service: ProfileStatsService = Depends(_stats_service),
):
    accessible = None if "*" in user.profiles else user.profiles
    return service.get_aggregated(accessible, range=range)


@profile_stats_router.post("/refresh")
def refresh_profile_stats(
    range: str = "all",
    user: User = Depends(get_current_user),
    service: ProfileStatsService = Depends(_stats_service),
):
    service.collect_local_stats()
    accessible = None if "*" in user.profiles else user.profiles
    return service.get_aggregated(accessible, range=range)


# ── /sync ───────────────────────────────────────────────────────────────────

sync_router = APIRouter(prefix="/sync", tags=["sync"])


class SyncSettingsOut(BaseModel):
    enabled: bool
    receive_enabled: bool
    target_url: str | None
    send_token: str | None
    receive_token: str | None
    interval: int
    send_endpoints: list[dict]


class SyncSettingsIn(BaseModel):
    enabled: bool
    receive_enabled: bool
    target_url: str | None = Field(default=None)
    send_token: str | None = Field(default=None)
    receive_token: str | None = Field(default=None)
    interval: int = Field(default=60, ge=10)
    send_endpoints: list[dict] = Field(default_factory=list)


@sync_router.get("/settings", response_model=SyncSettingsOut)
async def get_sync_settings(request: Request, user: User = Depends(require_admin)):
    settings: Settings = request.app.state.settings
    return SyncSettingsOut(
        enabled=settings.sync_enabled,
        receive_enabled=settings.sync_receive_enabled,
        target_url=settings.sync_target_url,
        send_token=settings.sync_send_token,
        receive_token=settings.sync_receive_token,
        interval=settings.sync_interval,
        send_endpoints=settings.sync_send_endpoints,
    )


@sync_router.put("/settings")
async def update_sync_settings(
    request: Request,
    body: SyncSettingsIn,
    user: User = Depends(require_admin),
):
    app_settings: Settings = request.app.state.settings
    update_config_file({
        "sync": {
            "send": {
                "enabled": body.enabled,
                "endpoint": body.target_url,
                "token": body.send_token,
                "interval": body.interval,
                "endpoints": body.send_endpoints,
            },
            "receive": {
                "enabled": body.receive_enabled,
                "token": body.receive_token,
            },
        }
    })

    set_receive_enabled(body.receive_enabled)
    set_send_enabled(body.enabled)

    app_settings.sync_enabled = body.enabled
    app_settings.sync_receive_enabled = body.receive_enabled
    app_settings.sync_target_url = body.target_url
    app_settings.sync_send_token = body.send_token
    app_settings.sync_send_endpoints = body.send_endpoints
    app_settings.sync_receive_token = body.receive_token
    app_settings.sync_interval = body.interval

    push_result = {"ok": False, "message": "sync not configured"}
    if body.enabled and (body.send_endpoints or body.target_url):
        push_result = await asyncio.to_thread(SyncService(app_settings).push)
    return {"ok": True, "push": push_result}


@sync_router.get("/status")
async def get_sync_status(
    request: Request,
    user: User = Depends(require_admin),
):
    settings: Settings = request.app.state.settings
    ensure_receive_token(settings)
    status_payload = get_receive_status()
    status_payload["send"] = get_send_status()
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip()
    forwarded_host = request.headers.get("x-forwarded-host", "").split(",", 1)[0].strip()
    browser_url = request.headers.get("origin") or request.headers.get("referer") or ""
    browser_parts = urlsplit(browser_url)
    scheme = forwarded_proto or browser_parts.scheme or request.url.scheme
    host = forwarded_host or browser_parts.netloc or request.headers.get("host", f"{settings.host}:{settings.port}")
    status_payload["receive_url"] = f"{scheme}://{host}/api/v1/sync/"
    status_payload["port"] = settings.port
    status_payload["receive_token"] = settings.sync_receive_token
    return status_payload


@sync_router.post("/")
async def receive_sync(request: Request):
    settings: Settings = request.app.state.settings
    if not settings.sync_receive_enabled:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="接收同步未启用")

    expected_token = settings.sync_receive_token
    if expected_token:
        auth_header = request.headers.get("Authorization", "")
        received_token = ""
        if auth_header.startswith("Bearer "):
            received_token = auth_header[7:]
        if received_token != expected_token:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="无效的同步凭证")

    body = await request.body()
    if not body:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请求体为空")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请求体不是合法的 JSON")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请求体必须是 JSON 对象")

    service = SyncService(settings)
    panel_name = request.headers.get("x-panel-name") or "unknown"
    try:
        result = service.ingest(payload, panel_name=panel_name)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    logger.info(
        "Sync received: panel=%s source=%s profiles=%d",
        panel_name,
        request.headers.get("user-agent", "-"),
        len(payload.get("profiles", [])),
    )
    return result


@sync_router.get("/auth-check")
async def sync_auth_check(request: Request):
    settings: Settings = request.app.state.settings
    if not settings.sync_receive_enabled:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="接收同步未启用")
    expected_token = settings.sync_receive_token
    auth_header = request.headers.get("Authorization", "")
    received_token = auth_header[7:] if auth_header.startswith("Bearer ") else ""
    if not expected_token or received_token != expected_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="无效的同步凭证")
    return {"ok": True}


@sync_router.post("/push")
async def trigger_push(
    request: Request,
    endpoint: str | None = None,
    user: User = Depends(require_admin),
):
    settings: Settings = request.app.state.settings
    if not settings.sync_enabled or not (
        settings.sync_send_endpoints or settings.sync_target_url
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="发送同步未启用或未配置目标地址",
        )
    service = SyncService(settings)
    result = await asyncio.to_thread(service.push, endpoint)
    if not result.get("ok"):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=result.get("message", "推送失败"),
        )
    return result