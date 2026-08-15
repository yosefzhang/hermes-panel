"""网关状态和控制 API"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from backend.auth.dependencies import ensure_profile_access, get_accessible_profiles, get_current_user
from backend.db.models import User
from backend.services.audit_log import log_audit_event
from backend.services.gateway_service import GatewayService
from backend.services.profile_service import ProfileService


router = APIRouter(prefix="/gateway", tags=["gateway"])


def gateway_service(request: Request) -> GatewayService:
    return GatewayService()


class GatewayActionRequest(BaseModel):
    profile: str


def _client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


@router.get("/status")
def get_gateway_status(
    profile: str | None = None,
    user: User = Depends(get_current_user),
    service: GatewayService = Depends(gateway_service),
):
    """
    获取网关状态

    - 如果不指定 profile，返回用户可访问的所有 profile 的网关状态
    - 如果指定 profile，返回该 profile 的网关状态（需要权限）
    """
    if profile:
        ensure_profile_access(user, profile)
        status = service.get_status(profile)
        return {"statuses": [status.to_dict()]}
    else:
        # 获取所有 profile 列表并过滤
        profile_svc = ProfileService(service.hermes_home)
        all_profiles = profile_svc.list_profiles()
        accessible_profiles = get_accessible_profiles(user, all_profiles)
        statuses = service.get_statuses(accessible_profiles)
        return {"statuses": [s.to_dict() for s in statuses]}


@router.get("/status/all")
def get_all_gateway_statuses(
    user: User = Depends(get_current_user),
    service: GatewayService = Depends(gateway_service),
):
    """
    获取用户可访问的所有 profile 的网关状态
    """
    profile_svc = ProfileService(service.hermes_home)
    all_profiles = profile_svc.list_profiles()
    accessible_profiles = get_accessible_profiles(user, all_profiles)
    statuses = service.get_statuses(accessible_profiles)
    return {"statuses": [s.to_dict() for s in statuses]}


@router.post("/start")
def start_gateway(
    request: Request,
    body: GatewayActionRequest,
    user: User = Depends(get_current_user),
    service: GatewayService = Depends(gateway_service),
):
    """启动指定 profile 的网关"""
    ensure_profile_access(user, body.profile)
    result = service.start(body.profile)
    log_audit_event(
        request.app.state.settings,
        action="gateway:start",
        actor=user.username,
        target_type="profile",
        target_id=body.profile,
        details={"message": result.get("message")},
        success=result.get("success"),
        ip_address=_client_ip(request),
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return result


@router.post("/stop")
def stop_gateway(
    request: Request,
    body: GatewayActionRequest,
    user: User = Depends(get_current_user),
    service: GatewayService = Depends(gateway_service),
):
    """停止指定 profile 的网关"""
    ensure_profile_access(user, body.profile)
    result = service.stop(body.profile)
    log_audit_event(
        request.app.state.settings,
        action="gateway:stop",
        actor=user.username,
        target_type="profile",
        target_id=body.profile,
        details={"message": result.get("message")},
        success=result.get("success"),
        ip_address=_client_ip(request),
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return result


@router.post("/restart")
def restart_gateway(
    request: Request,
    body: GatewayActionRequest,
    user: User = Depends(get_current_user),
    service: GatewayService = Depends(gateway_service),
):
    """重启指定 profile 的网关"""
    ensure_profile_access(user, body.profile)
    result = service.restart(body.profile)
    log_audit_event(
        request.app.state.settings,
        action="gateway:restart",
        actor=user.username,
        target_type="profile",
        target_id=body.profile,
        details={"message": result.get("message")},
        success=result.get("success"),
        ip_address=_client_ip(request),
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return result
