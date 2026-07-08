from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.api import (
    auth,
    channels,
    config,
    env,
    gateway,
    memory,
    models_config,
    plugins,
    profile_files,
    profiles,
    skills,
    system,
    tokens,
    users,
)
from backend.config import Settings, get_settings
from backend.db.database import init_database


def create_app(settings: Settings | None = None, initialize_database: bool = True) -> FastAPI:
    """Build the FastAPI application.

    `initialize_database=False` is for tests that wire their own settings
    and want to skip the default `admin` bootstrap (or have already done it).
    """
    settings = settings or get_settings()
    if initialize_database:
        init_database(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Re-run initialization on startup as well: this matters when
        # `initialize_database=False` is used (e.g. tests) but the app
        # still wants the schema and default admin ready before serving.
        init_database(app.state.settings)
        yield

    app = FastAPI(
        title=settings.app_name,
        lifespan=lifespan if initialize_database else None,
    )
    app.state.settings = settings

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    for router in (
        auth.router,
        users.router,
        config.router,
        env.router,
        profile_files.router,
        profiles.router,
        skills.router,
        plugins.router,
        models_config.router,
        channels.router,
        memory.router,
        tokens.router,
        system.router,
        gateway.router,
    ):
        app.include_router(router, prefix=settings.api_prefix)

    dist_path = Path(__file__).resolve().parent.parent / "frontend" / "dist"
    if dist_path.exists():
        assets_path = dist_path / "assets"
        if assets_path.exists():
            app.mount("/assets", StaticFiles(directory=assets_path), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        def serve_frontend(full_path: str):
            requested_path = dist_path / full_path
            if full_path and requested_path.is_file():
                return FileResponse(requested_path)
            return FileResponse(dist_path / "index.html")

    return app


# Module-level app for `uvicorn backend.main:app`.  Database init is
# deferred to the lifespan handler so dev-server reloads don't double
# bootstrap the admin user.
app = create_app(initialize_database=False)
