"""网关状态和控制 API"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from backend.auth.dependencies import get_current_user
from backend.db.models import User
from backend.services.gateway_service import GatewayService
from backend.services.profile_service import ProfileService


router = APIRouter(prefix="/gateway", tags=["gateway"])


def gateway_service(request: Request) -> GatewayService:
    return GatewayService(request.app.state.settings.hermes_home)


class GatewayActionRequest(BaseModel):
    profile: str


def _check_profile_access(user: User, profile: str) -> None:
    """检查用户是否有权限访问指定的 profile"""
    if user.role != "admin" and "*" not in user.profiles and profile not in user.profiles:
        raise HTTPException(status_code=403, detail=f"无权访问 profile: {profile}")


def _get_accessible_profiles(user: User, all_profiles: list[str]) -> list[str]:
    """获取用户可访问的 profile 列表"""
    if user.role == "admin" or "*" in user.profiles:
        return all_profiles
    return [p for p in all_profiles if p in user.profiles]


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
        _check_profile_access(user, profile)
        status = service.get_status(profile)
        return {"statuses": [status.to_dict()]}
    else:
        # 获取所有 profile 列表并过滤
        profile_svc = ProfileService(service.hermes_home)
        all_profiles = profile_svc.list_profiles()
        accessible_profiles = _get_accessible_profiles(user, all_profiles)
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
    accessible_profiles = _get_accessible_profiles(user, all_profiles)
    statuses = service.get_statuses(accessible_profiles)
    return {"statuses": [s.to_dict() for s in statuses]}


@router.post("/start")
def start_gateway(
    request: GatewayActionRequest,
    user: User = Depends(get_current_user),
    service: GatewayService = Depends(gateway_service),
):
    """启动指定 profile 的网关"""
    _check_profile_access(user, request.profile)
    result = service.start(request.profile)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return result


@router.post("/stop")
def stop_gateway(
    request: GatewayActionRequest,
    user: User = Depends(get_current_user),
    service: GatewayService = Depends(gateway_service),
):
    """停止指定 profile 的网关"""
    _check_profile_access(user, request.profile)
    result = service.stop(request.profile)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return result


@router.post("/restart")
def restart_gateway(
    request: GatewayActionRequest,
    user: User = Depends(get_current_user),
    service: GatewayService = Depends(gateway_service),
):
    """重启指定 profile 的网关"""
    _check_profile_access(user, request.profile)
    result = service.restart(request.profile)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return result
