from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request

from backend.auth.dependencies import ensure_profile_access, get_current_user
from backend.db.models import User
from backend.services.state_reader import StateReader


router = APIRouter(prefix="/tokens", tags=["tokens"])


def state_reader(request: Request) -> StateReader:
    return StateReader(request.app.state.settings.hermes_home)


def period_to_days(period: str) -> int:
    if period.endswith("d") and period[:-1].isdigit():
        return max(1, int(period[:-1]))
    if period == "today":
        return 1
    return 30


@router.get("/summary")
def token_summary(
    period: str = "30d",
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    reader: StateReader = Depends(state_reader),
):
    return reader.aggregate_token_stats(ensure_profile_access(user, profile), period_to_days(period))


@router.get("/trend")
def token_trend(
    period: str = "30d",
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    reader: StateReader = Depends(state_reader),
):
    summary = reader.aggregate_token_stats(ensure_profile_access(user, profile), period_to_days(period))
    return {"series": summary["daily"]}


@router.get("/dashboard")
def token_dashboard(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    reader: StateReader = Depends(state_reader),
):
    return reader.get_dashboard_data(ensure_profile_access(user, profile))


@router.get("/models")
def token_models(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    reader: StateReader = Depends(state_reader),
):
    return {"models": reader.list_used_models(ensure_profile_access(user, profile))}