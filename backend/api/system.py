from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Query, Request, WebSocket, WebSocketDisconnect


from backend.auth.dependencies import get_current_user, require_admin
from backend.db.models import User
from backend.services.audit_log import get_audit_logs
from backend.services.hermes_info_service import HermesInfoService
from backend.services.hermes_update_service import HermesUpdateService
from backend.services.system_monitor import SystemMonitor


router = APIRouter(prefix="/system", tags=["system"])


def monitor(request: Request) -> SystemMonitor:
    return SystemMonitor(request.app.state.settings.hermes_panel_db_path)


def hermes_info(request: Request) -> HermesInfoService:
    return HermesInfoService(request.app.state.settings.hermes_home, settings=request.app.state.settings)


@router.get("/health")
def health():
    """Public health check endpoint used by remote panels to verify reachability."""
    return {"status": "ok"}


@router.get("/stats")
def stats(_: User = Depends(require_admin), service: SystemMonitor = Depends(monitor)):
    return service.current_stats()


@router.get("/stats/history")
def history(
    minutes: int = Query(60, ge=1, le=1440),
    _: User = Depends(require_admin),
    service: SystemMonitor = Depends(monitor),
):
    return service.history(minutes)


@router.get("/hermes-info")
def hermes_dashboard_info(
    current_user: User = Depends(get_current_user),
    service: HermesInfoService = Depends(hermes_info),
):
    """获取 Hermes 相关信息用于仪表盘展示，只返回当前用户可见的 profile"""
    return service.get_dashboard_info(current_user)


@router.get("/versions")
def system_versions(
    _: User = Depends(get_current_user),
    service: HermesInfoService = Depends(hermes_info),
):
    """获取系统组件版本"""
    return service.get_system_versions()


@router.get("/hermes-update")
def check_hermes_update(
    _: User = Depends(require_admin),
):
    """检查 Hermes 是否有新版本（仅 admin 可用）"""
    service = HermesUpdateService()
    return service.check_for_updates()


@router.post("/hermes-upgrade")
def start_hermes_upgrade(
    _: User = Depends(require_admin),
):
    """启动 Hermes 升级（仅 admin 可用）"""
    service = HermesUpdateService()
    return service.start_upgrade()


@router.get("/hermes-upgrade/status")
def get_hermes_upgrade_status(
    _: User = Depends(require_admin),
):
    """获取 Hermes 升级状态（仅 admin 可用）"""
    return HermesUpdateService.get_upgrade_status()


@router.websocket("/ws/system")
async def ws_system(websocket: WebSocket):
    await websocket.accept()
    service = SystemMonitor(websocket.app.state.settings.hermes_panel_db_path)
    try:
        while True:
            await websocket.send_json(service.current_stats())
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        return


# ── Audit logs (kept under /audit-logs prefix for API stability) ────────────

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
    """Return recent audit log entries, newest first.

    Optional query parameters allow filtering by action, target_type or
    target_id.
    """
    logs = get_audit_logs(
        request.app.state.settings,
        limit=max(1, min(limit, 1000)),
        offset=max(0, offset),
        action=action,
        target_type=target_type,
        target_id=target_id,
    )
    return {"logs": [log.to_dict() for log in logs]}
