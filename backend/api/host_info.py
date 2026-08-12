from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from backend.auth.dependencies import require_admin
from backend.db.models import User
from backend.services.host_info_service import HostInfoService


router = APIRouter(prefix="/host-info", tags=["host-info"])


def _service(request: Request) -> HostInfoService:
    return HostInfoService(request.app.state.settings)


@router.get("/")
def list_host_info(
    _: User = Depends(require_admin),
    service: HostInfoService = Depends(_service),
):
    """Return host metadata for all known servers (local + child panels)."""
    return {"hosts": [h.to_dict() for h in service.get_all_host_info()]}
