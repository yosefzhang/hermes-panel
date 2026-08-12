from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from backend.auth.dependencies import get_current_user
from backend.db.models import User
from backend.services.host_info_service import HostInfoService
from backend.services.profile_stats_service import ProfileStatsService


router = APIRouter(prefix="/profiles/aggregated", tags=["profiles"])


def _stats_service(request: Request) -> ProfileStatsService:
    return ProfileStatsService(request.app.state.settings)


def _host_service(request: Request) -> HostInfoService:
    return HostInfoService(request.app.state.settings)


@router.get("")
def list_profile_stats(
    user: User = Depends(get_current_user),
    service: ProfileStatsService = Depends(_stats_service),
):
    """Return aggregated profile statistics for all known servers.

    Admin users see all profiles; regular users only see profiles they are
    authorised for.
    """
    accessible = None if "*" in user.profiles else user.profiles
    return service.get_aggregated(accessible)


@router.post("/refresh")
def refresh_profile_stats(
    user: User = Depends(get_current_user),
    service: ProfileStatsService = Depends(_stats_service),
    host_service: HostInfoService = Depends(_host_service),
):
    """Force a synchronous re-collection of local profile stats + host info
    before returning the freshly aggregated snapshot.

    The background loop updates the panel DB every 60s, so a click on the
    UI "刷新" button would otherwise only re-read stale cached rows. This
    endpoint runs ``collect_local_stats`` and ``refresh_local`` inline so
    the very next response reflects current Hermes state.
    """
    service.collect_local_stats()
    host_service.refresh_local()
    accessible = None if "*" in user.profiles else user.profiles
    return service.get_aggregated(accessible)
