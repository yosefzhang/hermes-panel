"""Profile statistics aggregation and persistence.

Collects per-profile metrics (gateway status, session/token counts, model/provider
breakdowns, daily usage) from local Hermes state databases and persists them into
the panel's control database. Child panels send their local stats to the master via
the federation heartbeat; the master stores them under the child agent's server id.
"""
from __future__ import annotations

import json
import logging
import re
import socket
import subprocess
import time
from pathlib import Path

from backend.config import Settings
from backend.db.database import connect
from backend.db.models import Profile
from backend.services.cli_runner import find_command
from backend.services.gateway_service import GatewayService
from backend.services.host_info_service import get_primary_ip, get_username, make_server_id
from backend.services.profile_service import ProfileService
from backend.services.state_reader import StateReader
from backend.services.subprocess_utils import get_clean_env

logger = logging.getLogger(__name__)

_DAILY_DAYS = 15
_TOP_N = 5


class ProfileStatsService:
    """Service for collecting and querying profile statistics."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.db_path = settings.hermes_panel_db_path
        self.hermes_home = settings.hermes_home
        # Cache the host-level latest config version for one collection cycle;
        # it is identical across all profiles on the same hermes install.
        self._cached_latest_version: int | None = None
        self._latest_version_resolved = False

    def _latest_config_version(self) -> int | None:
        """Best-effort lookup of the hermes-agent default config schema version.

        Mirrors the ``latest`` half of hermes' ``check_config_version()``:
        the value of ``DEFAULT_CONFIG["_config_version"]`` for the installed
        hermes-agent. Resolved once per service instance and cached. Returns
        None when the CLI is unavailable or the output can't be parsed.
        """
        if self._latest_version_resolved:
            return self._cached_latest_version

        self._latest_version_resolved = True
        hermes = find_command("hermes")
        if not hermes:
            return None
        try:
            env = get_clean_env(self.hermes_home)
            result = subprocess.run(
                [hermes, "config", "check"],
                capture_output=True,
                text=True,
                timeout=15,
                env=env,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError):
            return None
        if result.returncode != 0:
            return None
        # Output line looks like: "  Config version: 30 → 33 (update available)"
        for line in result.stdout.splitlines():
            m = re.search(r"config version:\s*\d+\s*[→>]\s*(\d+)", line, re.IGNORECASE)
            if m:
                self._cached_latest_version = int(m.group(1))
                return self._cached_latest_version
        return None

    def collect_local_stats(self) -> None:
        """Scan local profiles and upsert their statistics into the profiles DB."""
        profile_svc = ProfileService(self.hermes_home)
        gateway_svc = GatewayService()
        state_reader = StateReader(self.hermes_home)
        profiles = profile_svc.list_profiles()
        host = socket.gethostname()
        username = get_username()
        ip = get_primary_ip()
        now = time.time()
        collected = 0

        logger.info(
            "collect_local_stats: start scan host=%s user=%s ip=%s profiles=%d",
            host, username, ip, len(profiles),
        )

        with connect(self.db_path) as conn:
            for profile in profiles:
                info = profile_svc.get_profile_info(profile)
                if not info.exists:
                    logger.debug("collect_local_stats: skip non-existent profile=%s", profile)
                    continue

                gw = gateway_svc.get_status(profile)
                token_data = state_reader.get_dashboard_data(profile)
                summary = token_data.get("summary", {})

                model_top5 = self._top_n_by_tokens(token_data.get("by_model", []))
                provider_top5 = self._top_n_by_tokens(token_data.get("by_provider", []))
                daily = token_data.get("daily", [])
                daily_last15 = daily[-_DAILY_DAYS:] if len(daily) > _DAILY_DAYS else daily

                total_tokens = int(summary.get("total_tokens", 0))

                self._upsert(
                    conn,
                    host=host,
                    username=username,
                    ip=ip,
                    profile_name=profile,
                    path=str(profile_svc.profile_root(profile)),
                    gateway_status="running" if gw.running else "stopped",
                    session_count=int(summary.get("total_sessions", 0)),
                    total_tokens=total_tokens,
                    total_input_tokens=int(summary.get("total_input_tokens", 0)),
                    total_output_tokens=int(summary.get("total_output_tokens", 0)),
                    cache_hit_rate=float(summary.get("cache_hit_rate", 0.0)),
                    model_top5=model_top5,
                    provider_top5=provider_top5,
                    daily_tokens=daily_last15,
                    current_config_version=profile_svc.get_config_version(profile),
                    latest_config_version=self._latest_config_version(),
                    updated_at=now,
                )
                collected += 1
                logger.info(
                    "collect_local_stats: upserted profile=%s gw=%s tokens=%d sessions=%s",
                    profile,
                    "running" if gw.running else "stopped",
                    total_tokens,
                    summary.get("total_sessions", 0),
                )

        # commit happens implicitly on context exit; log a compact summary
        logger.info(
            "collect_local_stats: done collected=%d/%d elapsed=%.2fs",
            collected, len(profiles), round(time.time() - now, 2),
        )

    def get_all_stats(self, accessible_profiles: list[str] | None = None) -> list[Profile]:
        """Return stored profile stats, optionally filtered by accessible profile names."""
        with connect(self.db_path) as conn:
            if accessible_profiles is None:
                rows = conn.execute(
                    "SELECT * FROM profiles ORDER BY host, username, ip, profile_name"
                ).fetchall()
            else:
                placeholders = ",".join("?" * len(accessible_profiles))
                rows = conn.execute(
                    f"""
                    SELECT * FROM profiles
                    WHERE profile_name IN ({placeholders})
                    ORDER BY host, username, ip, profile_name
                    """,
                    accessible_profiles,
                ).fetchall()
        return [_row_to_profile(row) for row in rows]

    def get_aggregated(self, accessible_profiles: list[str] | None = None) -> dict:
        """Return stats grouped by server (host + username + ip)."""
        stats = self.get_all_stats(accessible_profiles)
        servers: dict[str, dict] = {}
        local_server_id = make_server_id(socket.gethostname(), get_username(), get_primary_ip())

        for s in stats:
            if s.server_id not in servers:
                servers[s.server_id] = {
                    "id": s.server_id,
                    "name": s.host or s.server_id,
                    "host": s.host,
                    "username": s.username,
                    "ip": s.ip,
                    "hermes_version": s.hermes_version,
                    "components": s.components,
                    "is_local": s.server_id == local_server_id,
                    "online": True,
                    "profiles": [],
                }
            servers[s.server_id]["profiles"].append(s.to_dict())

        return {
            "servers": list(servers.values()),
        }

    @staticmethod
    def _top_n_by_tokens(items: list[dict]) -> list[dict]:
        sorted_items = sorted(
            items,
            key=lambda x: x.get("total_tokens", 0),
            reverse=True,
        )
        return sorted_items[:_TOP_N]

    @staticmethod
    def _upsert(
        conn,
        host: str | None,
        username: str | None,
        ip: str | None,
        profile_name: str,
        path: str | None,
        gateway_status: str | None,
        session_count: int,
        total_tokens: int,
        total_input_tokens: int,
        total_output_tokens: int,
        cache_hit_rate: float,
        model_top5: list[dict],
        provider_top5: list[dict],
        daily_tokens: list[dict],
        current_config_version: int | None,
        latest_config_version: int | None,
        updated_at: float,
    ) -> None:
        conn.execute(
            """
            INSERT INTO profiles (
                host, username, ip, profile_name, path, gateway_status, session_count,
                total_tokens, total_input_tokens, total_output_tokens, cache_hit_rate,
                model_top5, provider_top5, daily_tokens, current_config_version,
                latest_config_version, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(host, username, ip, profile_name) DO UPDATE SET
                path=excluded.path,
                gateway_status=excluded.gateway_status,
                session_count=excluded.session_count,
                total_tokens=excluded.total_tokens,
                total_input_tokens=excluded.total_input_tokens,
                total_output_tokens=excluded.total_output_tokens,
                cache_hit_rate=excluded.cache_hit_rate,
                model_top5=excluded.model_top5,
                provider_top5=excluded.provider_top5,
                daily_tokens=excluded.daily_tokens,
                current_config_version=excluded.current_config_version,
                latest_config_version=excluded.latest_config_version,
                updated_at=excluded.updated_at
            """,
            (
                host,
                username,
                ip,
                profile_name,
                path,
                gateway_status,
                session_count,
                total_tokens,
                total_input_tokens,
                total_output_tokens,
                cache_hit_rate,
                json.dumps(model_top5),
                json.dumps(provider_top5),
                json.dumps(daily_tokens),
                current_config_version,
                latest_config_version,
                updated_at,
            ),
        )


def _row_to_profile(row) -> Profile:
    def _load_json(field: str):
        try:
            value = json.loads(row[field])
            return value
        except Exception:
            return [] if field in ("model_top5", "provider_top5", "daily_tokens") else {}

    return Profile(
        id=row["id"],
        host=row["host"],
        username=row["username"],
        ip=row["ip"],
        profile_name=row["profile_name"],
        path=row["path"],
        gateway_status=row["gateway_status"],
        session_count=row["session_count"],
        total_tokens=row["total_tokens"],
        total_input_tokens=row["total_input_tokens"],
        total_output_tokens=row["total_output_tokens"],
        cache_hit_rate=row["cache_hit_rate"],
        model_top5=_load_json("model_top5"),
        provider_top5=_load_json("provider_top5"),
        daily_tokens=_load_json("daily_tokens"),
        hermes_version=row["hermes_version"],
        components=_load_json("components"),
        current_config_version=row["current_config_version"],
        latest_config_version=row["latest_config_version"],
        updated_at=row["updated_at"],
    )

    @staticmethod
    def _latest_config_version(self) -> int:
        """Return the latest config version for the current host."""
        return self.get_config_version(self.get_profile_name())
