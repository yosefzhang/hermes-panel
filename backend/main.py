from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

from fastapi import Request

# hermes-panel is a management tool and must not be bound to any Hermes
# profile. Force HERMES_HOME to the current user's base Hermes directory
# and drop any inherited profile binding so subprocess hermes calls don't
# fall back to (or write into) the wrong profile.
os.environ["HERMES_HOME"] = str(Path.home() / ".hermes")
os.environ.pop("HERMES_PROFILE", None)

# hermes-agent discovers bundled plugins on import and logs warnings for
# optional platform plugins (slack-platform, wecom-platform, etc.) that
# hermes-panel does not need. Raise the threshold to keep startup logs clean.
logging.getLogger("hermes_cli.plugins").setLevel(logging.ERROR)

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.api import (
    auth,
    channels,
    config,
    gateway,
    memory,
    models_config,
    plugins,
    profile_files,
    profile_stats,
    profiles,
    skills,
    sync,
    system,
    tokens,
    users,
)
from backend.config import Settings, get_settings
from backend.db.database import init_database
from backend.services.host_info_service import HostInfoService
from backend.services.profile_stats_service import ProfileStatsService
from backend.services.sync_service import SyncService, ensure_receive_token, get_receive_status, initialize_receive_state_from_settings, initialize_send_state_from_settings, set_receive_enabled, set_send_enabled


logger = logging.getLogger(__name__)
# Profile stats and host metadata are now stored in separate tables, so they
# refresh on independent cadences:
#   - profile_info: fast (gateway + token totals) every 10 min, full (all
#     fields) every 1 h — both owned by ProfileStatsService.
#   - host_info: host-level metadata (hermes version, components) every 1 h
#     only — owned by HostInfoService. The fast cycle no longer touches the
#     host_info table.
_FAST_REFRESH_INTERVAL = 600   # 10 min: profile_info gateway status + token totals
_FULL_REFRESH_INTERVAL = 3600  # 1 h: profile_info full + host_info metadata

# A typical uvicorn dev session already configures its own handlers; avoid
# touching logging when we detect a non-empty child logger config (e.g.
# `--reload` sets up `logging.getLogger("uvicorn")` handlers).
_LOG_FORMAT = "%(asctime)s %(name)s %(levelname)s %(message)s"


def setup_logging(settings: Settings) -> None:
    """Configure root logger to write to a rotating file under the panel
    config dir, while still mirroring to stderr so dev-server output is
    not lost.

    Safe to call multiple times: re-adding handlers is a no-op because we
    tag them with a unique ``_hermes_panel_tag`` attribute and clear
    previously tagged handlers first.
    """
    log_path = Path(settings.log_file_path).expanduser()
    log_path.parent.mkdir(parents=True, exist_ok=True)

    level = getattr(logging, settings.log_level.upper(), logging.INFO)

    root = logging.getLogger()
    root.setLevel(level)

    # Remove previously installed hermes-panel handlers so re-init in dev
    # reloads doesn't stack duplicate handlers.
    root.handlers = [h for h in root.handlers if not getattr(h, "_hermes_panel_tag", False)]

    formatter = logging.Formatter(_LOG_FORMAT)

    file_handler = RotatingFileHandler(
        log_path,
        maxBytes=settings.log_max_bytes,
        backupCount=settings.log_backup_count,
        encoding="utf-8",
    )
    file_handler.setLevel(level)
    file_handler.setFormatter(formatter)
    file_handler._hermes_panel_tag = True  # type: ignore[attr-defined]
    root.addHandler(file_handler)

    # Keep stderr mirror for `uvicorn` / `make dev` terminal output.
    stderr_handler = logging.StreamHandler(sys.stderr)
    stderr_handler.setLevel(level)
    stderr_handler.setFormatter(formatter)
    stderr_handler._hermes_panel_tag = True  # type: ignore[attr-defined]
    root.addHandler(stderr_handler)

    logger.info(
        "Logging initialised: file=%s level=%s max_bytes=%d backup_count=%d",
        log_path, settings.log_level, settings.log_max_bytes, settings.log_backup_count,
    )


def create_app(settings: Settings | None = None, initialize_database: bool = True) -> FastAPI:
    """Build the FastAPI application.

    `initialize_database=False` is for tests that wire their own settings
    and want to skip the default `admin` bootstrap (or have already done it).
    """
    settings = settings or get_settings()

    # Configure file logging as early as possible so startup errors land in
    # the log file even if the lifespan handler never gets to run.
    setup_logging(settings)

    if initialize_database:
        init_database(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Re-run initialization on startup as well: this matters when
        # `initialize_database=False` is used (e.g. tests) but the app
        # still wants the schema and default admin ready before serving.
        await asyncio.to_thread(init_database, app.state.settings)

        # Restore receive-sync runtime state from persisted settings.
        initialize_receive_state_from_settings(app.state.settings)
        # Ensure a receive token exists so senders always have one to use.
        ensure_receive_token(app.state.settings)

        # Restore send-sync runtime state from persisted settings.
        initialize_send_state_from_settings(app.state.settings)

        # Start local data collection. Profile stats and host metadata now
        # live in separate tables (profile_info / host_info) refreshed on
        # independent cadences, but still share one background loop so the
        # two stay timestamp-coherent within the full cycle.
        stats_service = ProfileStatsService(app.state.settings)
        host_info_service = HostInfoService(app.state.settings)
        local_data_task = asyncio.create_task(
            _refresh_local_data(stats_service, host_info_service)
        )

        # Start sync task. The loop stays alive for the whole process
        # lifetime and only pushes when the nested send config is enabled and
        # has an endpoint.
        # are both configured, so toggling the setting at runtime takes
        # effect without restarting the server.
        sync_service = SyncService(app.state.settings)
        sync_task = asyncio.create_task(_run_sync_loop(sync_service))

        yield
        local_data_task.cancel()
        sync_task.cancel()
        for task in (local_data_task, sync_task):
            try:
                await task
            except asyncio.CancelledError:
                pass

    app = FastAPI(
        title=settings.app_name,
        lifespan=lifespan,
    )
    app.state.settings = settings

    @app.middleware("http")
    async def request_logging_middleware(request: Request, call_next):
        """Log every API request with method, path, status, and duration."""
        start_time = time.time()
        client = request.client.host if request.client else "-"
        try:
            response = await call_next(request)
            duration_ms = (time.time() - start_time) * 1000
            logger.info(
                "API %s %s from=%s status=%d duration=%.1fms",
                request.method,
                request.url.path,
                client,
                response.status_code,
                duration_ms,
            )
            return response
        except Exception:
            duration_ms = (time.time() - start_time) * 1000
            logger.exception(
                "API %s %s from=%s FAILED after %.1fms",
                request.method,
                request.url.path,
                client,
                duration_ms,
            )
            raise

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    routers = [
        auth.router,
        users.router,
        config.router,
        profile_files.router,
        profile_stats.router,
        profiles.router,
        skills.router,
        plugins.router,
        models_config.router,
        channels.router,
        memory.router,
        tokens.router,
        system.router,
        system.audit_router,
        gateway.router,
        sync.router,
    ]

    for router in routers:
        app.include_router(router, prefix=settings.api_prefix)

    dist_path = Path(__file__).resolve().parent.parent / "frontend" / "dist"
    if dist_path.exists():
        assets_path = dist_path / "assets"
        if assets_path.exists():
            app.mount("/assets", StaticFiles(directory=assets_path), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        async def serve_frontend(full_path: str):
            requested_path = dist_path / full_path
            if full_path and requested_path.is_file():
                return FileResponse(requested_path)
            # The entrypoint contains hashed asset names and must be fetched
            # again after each production build; otherwise browsers can keep
            # an old index that references deleted chunks.
            return FileResponse(
                dist_path / "index.html",
                headers={
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache",
                    "Expires": "0",
                },
            )

    return app


async def _refresh_local_data(
    stats_service: ProfileStatsService,
    host_info_service: HostInfoService,
) -> None:
    """Background loop with two cadences:

    - Every 10 min: fast profile stats (gateway status + token totals) only.
      The host_info table is intentionally *not* refreshed on the fast cycle;
      its data (hermes version, component versions) changes slowly.
    - Every 1 hour: full profile stats (memory status, config version,
      model/provider breakdowns, daily tokens) + host info refresh.

    Host metadata is refreshed alongside the full cycle so the dashboard
    reflects version changes reasonably quickly without hammering the CLI
    sub-processes every 10 minutes.
    """
    logger.info(
        "Local data refresh loop starting (fast=%ds, full=%ds)",
        _FAST_REFRESH_INTERVAL, _FULL_REFRESH_INTERVAL,
    )

    # Run a full collection immediately on startup so the first dashboard
    # render has complete data.
    try:
        stats_service.cleanup_stale_records()
        await asyncio.to_thread(stats_service.collect_local_stats)
        await asyncio.to_thread(host_info_service.refresh_local)
    except Exception:
        logger.exception("Initial full data collection failed")

    last_full = time.time()
    while True:
        try:
            await asyncio.sleep(_FAST_REFRESH_INTERVAL)
            await asyncio.to_thread(stats_service.cleanup_stale_records)
            elapsed_since_full = time.time() - last_full
            if elapsed_since_full >= _FULL_REFRESH_INTERVAL:
                logger.info("Local data refresh cycle (full) start")
                await asyncio.to_thread(stats_service.collect_local_stats)
                await asyncio.to_thread(host_info_service.refresh_local)
                last_full = time.time()
                logger.info("Local data refresh cycle (full) done")
            else:
                logger.info("Local data refresh cycle (fast) start")
                await asyncio.to_thread(stats_service.collect_fast_stats)
                logger.info("Local data refresh cycle (fast) done")
        except asyncio.CancelledError:
            logger.info("Local data refresh loop cancelled")
            break
        except Exception:
            logger.exception("Local data refresh failed")


async def _run_sync_loop(service: SyncService) -> None:
    """Background loop that pushes local stats to a target panel."""
    while True:
        try:
            await asyncio.sleep(service.settings.sync_interval)
        except asyncio.CancelledError:
            break

        if not service.settings.sync_enabled or not (
            service.settings.sync_send_endpoints or service.settings.sync_target_url
        ):
            continue

        try:
            # SyncService.push records per-endpoint results internally.
            await asyncio.to_thread(service.push)
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("Sync push failed")


# Module-level app for `uvicorn backend.main:app`.  Database init is
# deferred to the lifespan handler so dev-server reloads don't double
# bootstrap the admin user.
app = create_app(initialize_database=False)
