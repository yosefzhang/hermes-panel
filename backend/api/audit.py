"""Audit log API for administrators."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from backend.auth.dependencies import require_admin
from backend.db.models import User
from backend.services.audit_log import get_audit_logs


router = APIRouter(prefix="/audit-logs", tags=["audit"])


@router.get("")
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
