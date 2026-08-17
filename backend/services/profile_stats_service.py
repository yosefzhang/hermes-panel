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
import threading
import time
from pathlib import Path

from backend.config import Settings
from backend.db.database import connect
from backend.db.models import Profile
from backend.services.cli_utils import find_command, get_clean_env
from backend.services.gateway_service import GatewayService
from backend.services.host_info_service import get_primary_ip, get_username, make_server_id
from backend.services.profile_service import ProfileService
from backend.services.state_reader import StateReader

logger = logging.getLogger(__name__)

_DAILY_DAYS = 15
_STALE_RECORD_SECONDS = 24 * 60 * 60
_TOP_N = 5

# Fields in the profile_info table that are stored as JSON strings.
_JSON_FIELDS = {"model_top5", "provider_top5", "daily_tokens"}

# Default values for JSON fields when parsing fails.
_JSON_DEFAULTS = {
    "model_top5": [],
    "provider_top5": [],
    "daily_tokens": [],
}


def _load_json_field(row, field: str):
    """Load a JSON field from a database row with safe fallback."""
    try:
        value = json.loads(row[field])
        return value
    except Exception:
        return _JSON_DEFAULTS.get(field, {})


class ProfileStatsService:
    """Service for collecting and querying profile statistics."""

    _collect_lock = threading.Lock()

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
            full_cmd = [hermes, "config", "check"]
            logger.info("_latest_config_version: running cmd=%s", full_cmd)
            result = subprocess.run(
                full_cmd,
                capture_output=True,
                text=True,
                timeout=15,
                env=env,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError) as exc:
            logger.error("_latest_config_version: cmd=%s failed: %s", full_cmd, exc)
            return None
        logger.info(
            "_latest_config_version: cmd=%s rc=%d stdout_len=%d stderr_len=%d",
            full_cmd, result.returncode, len(result.stdout), len(result.stderr),
        )
        if result.returncode != 0:
            logger.warning(
                "_latest_config_version: cmd=%s rc=%d stderr=%s",
                full_cmd, result.returncode, result.stderr[:500],
            )
            return None
        # Hermes prints either "Config version: 30 -> 33" when an update is
        # available or "Config version: 33 ✓" when the config is current.
        for line in result.stdout.splitlines():
            m = re.search(r"config version:\s*\d+\s*[→>]\s*(\d+)", line, re.IGNORECASE)
            if m:
                self._cached_latest_version = int(m.group(1))
                return self._cached_latest_version
            m = re.search(r"config version:\s*(\d+)", line, re.IGNORECASE)
            if m:
                self._cached_latest_version = int(m.group(1))
                return self._cached_latest_version
        return None

    def _collect_memory_status(self, profile: str) -> dict:
        """Run ``hermes -p <profile> memory status`` and extract the four
        values we persist in the profiles table.

        Returns a dict with keys: available (bool|None), provider (str|None),
        endpoint (str|None), agent (str|None).  All None on failure.
        """
        hermes = find_command("hermes")
        if not hermes:
            return {"available": None, "provider": None, "endpoint": None, "agent": None}
        try:
            env = get_clean_env(self.hermes_home)
            full_cmd = [hermes, "-p", profile, "memory", "status"]
            logger.info("_collect_memory_status: running cmd=%s", full_cmd)
            result = subprocess.run(
                full_cmd,
                capture_output=True, text=True, timeout=30, env=env,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError) as exc:
            logger.error("_collect_memory_status: cmd=%s failed: %s", full_cmd, exc)
            return {"available": None, "provider": None, "endpoint": None, "agent": None}
        logger.info(
            "_collect_memory_status: cmd=%s rc=%d stdout_len=%d stderr_len=%d",
            full_cmd, result.returncode, len(result.stdout), len(result.stderr),
        )
        if result.returncode != 0:
            logger.warning(
                "_collect_memory_status: cmd=%s rc=%d stderr=%s",
                full_cmd, result.returncode, result.stderr[:500],
            )
            return {"available": None, "provider": None, "endpoint": None, "agent": None}

        text = result.stdout.strip()
        provider = None
        endpoint = None
        agent = None
        available = None
        in_provider_config = False

        for raw_line in text.splitlines():
            line = raw_line.rstrip()
            stripped = line.strip()
            if not stripped:
                continue

            if line.startswith("  Provider:"):
                m = re.search(r"Provider:\s*(\S+)", line)
                provider = m.group(1) if m else None
                in_provider_config = False
                continue

            if stripped.endswith(" config:") and provider:
                in_provider_config = True
                continue

            if line.startswith("  Status:"):
                available = "available" in stripped.lower() or "✓" in stripped
                in_provider_config = False
                continue

            if in_provider_config and ":" in line:
                key, _, value = line.partition(":")
                key = key.strip()
                value = value.strip()
                if key == "endpoint":
                    endpoint = value
                elif key == "agent":
                    agent = value

        return {
            "available": available,
            "provider": provider,
            "endpoint": endpoint,
            "agent": agent,
        }

    def collect_local_stats(self) -> None:
        """Full collection: all profile stats + memory status (hourly).

        Guarded by a class-level lock so the background refresh loop and a
        synchronous API refresh request can't run concurrently and cause
        ``database is locked`` errors.
        """
        if not ProfileStatsService._collect_lock.acquire(blocking=False):
            logger.info("collect_local_stats: another collection is already running, skipping")
            return
        try:
            self._collect_impl(full=True)
        finally:
            ProfileStatsService._collect_lock.release()

    def collect_fast_stats(self) -> None:
        """Fast collection: only token/gateway data (every 10 min).

        Skips memory status, config version, model/provider breakdowns —
        those are refreshed by the full hourly cycle.
        """
        if not ProfileStatsService._collect_lock.acquire(blocking=False):
            logger.info("collect_fast_stats: another collection is already running, skipping")
            return
        try:
            self._collect_impl(full=False)
        finally:
            ProfileStatsService._collect_lock.release()

    def _collect_impl(self, full: bool) -> None:
        """Actual collection logic (called under the lock).

        When *full* is True, collects all fields including memory status,
        config version, model/provider top5.  When False, only collects
        gateway status and token totals (the fast path).
        """
        profile_svc = ProfileService(self.hermes_home)
        gateway_svc = GatewayService()
        state_reader = StateReader(self.hermes_home)
        profiles = profile_svc.list_profiles()
        host = socket.gethostname()
        username = get_username()
        ip = get_primary_ip()
        now = time.time()
        collected = 0
        mode = "full" if full else "fast"

        logger.info(
            "collect_local_stats(%s): start scan host=%s user=%s ip=%s profiles=%d",
            mode, host, username, ip, len(profiles),
        )

        with connect(self.db_path) as conn:
            for profile in profiles:
                info = profile_svc.get_profile_info(profile)
                if not info.exists:
                    logger.debug("collect_local_stats(%s): skip non-existent profile=%s", mode, profile)
                    continue

                gw = gateway_svc.get_status(profile)
                token_data = state_reader.get_dashboard_data(profile)
                summary = token_data.get("summary", {})

                total_tokens = int(summary.get("total_tokens", 0))

                if full:
                    model_top5 = self._top_n_by_tokens(token_data.get("by_model", []))
                    provider_top5 = self._top_n_by_tokens(token_data.get("by_provider", []))
                    daily = token_data.get("daily", [])
                    daily_last15 = daily[-_DAILY_DAYS:] if len(daily) > _DAILY_DAYS else daily
                    mem_status = self._collect_memory_status(profile)

                    self.upsert(
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
                        memory_available=mem_status["available"],
                        memory_provider=mem_status["provider"],
                        memory_endpoint=mem_status["endpoint"],
                        memory_agent=mem_status["agent"],
                        updated_at=now,
                    )
                else:
                    self.upsert_fast(
                        conn,
                        host=host,
                        username=username,
                        ip=ip,
                        profile_name=profile,
                        gateway_status="running" if gw.running else "stopped",
                        session_count=int(summary.get("total_sessions", 0)),
                        total_tokens=total_tokens,
                        total_input_tokens=int(summary.get("total_input_tokens", 0)),
                        total_output_tokens=int(summary.get("total_output_tokens", 0)),
                        cache_hit_rate=float(summary.get("cache_hit_rate", 0.0)),
                        updated_at=now,
                    )
                collected += 1
                logger.info(
                    "collect_local_stats(%s): upserted profile=%s gw=%s tokens=%d sessions=%s",
                    mode,
                    profile,
                    "running" if gw.running else "stopped",
                    total_tokens,
                    summary.get("total_sessions", 0),
                )

        # commit happens implicitly on context exit; log a compact summary
        logger.info(
            "collect_local_stats(%s): done collected=%d/%d elapsed=%.2fs",
            mode, collected, len(profiles), round(time.time() - now, 2),
        )

    def get_all_stats(self, accessible_profiles: list[str] | None = None) -> list[Profile]:
        """Return stored profile stats, optionally filtered by accessible profile names."""
        with connect(self.db_path) as conn:
            if accessible_profiles is None:
                rows = conn.execute(
                    "SELECT * FROM profile_info ORDER BY host, username, ip, profile_name"
                ).fetchall()
            else:
                placeholders = ",".join("?" * len(accessible_profiles))
                rows = conn.execute(
                    f"""
                    SELECT * FROM profile_info
                    WHERE profile_name IN ({placeholders})
                    ORDER BY host, username, ip, profile_name
                    """,
                    accessible_profiles,
                ).fetchall()
        return [_row_to_profile(row) for row in rows]

    def cleanup_stale_records(self, now: float | None = None) -> int:
        """Delete profile and host records that have not updated for 24 hours."""
        cutoff = (now if now is not None else time.time()) - _STALE_RECORD_SECONDS
        with connect(self.db_path) as conn:
            profile_cursor = conn.execute(
                "DELETE FROM profile_info WHERE updated_at < ?", (cutoff,)
            )
            host_cursor = conn.execute(
                "DELETE FROM host_info WHERE updated_at < ?", (cutoff,)
            )
        deleted = (profile_cursor.rowcount or 0) + (host_cursor.rowcount or 0)
        if deleted:
            logger.info(
                "cleanup_stale_records: deleted profiles=%d hosts=%d cutoff=%.0f",
                profile_cursor.rowcount or 0,
                host_cursor.rowcount or 0,
                cutoff,
            )
        return deleted

    def get_aggregated(self, accessible_profiles: list[str] | None = None) -> dict:
        """Return stats grouped by server (host + username + ip).

        Host-level metadata (hermes_version, components) now lives in the
        separate host_info table; we fetch it once and graft it onto the
        server group keyed by the same (host, username, ip) tuple.
        """
        self.cleanup_stale_records()
        stats = self.get_all_stats(accessible_profiles)
        servers: dict[str, dict] = {}
        local_server_id = make_server_id(socket.gethostname(), get_username(), get_primary_ip())

        # Pull host-level metadata from host_info (one row per server).
        host_meta: dict[str, dict] = {}
        with connect(self.db_path) as conn:
            host_rows = conn.execute(
                "SELECT host, username, ip, hermes_version, components, updated_at "
                "FROM host_info"
            ).fetchall()
        for h in host_rows:
            sid = make_server_id(h["host"] or "", h["username"] or "", h["ip"] or "")
            try:
                components = json.loads(h["components"] or "{}")
            except Exception:
                components = {}
            host_meta[sid] = {
                "hermes_version": h["hermes_version"],
                "components": components,
                "updated_at": h["updated_at"],
            }

        for s in stats:
            if s.server_id not in servers:
                meta = host_meta.get(s.server_id, {})
                servers[s.server_id] = {
                    "id": s.server_id,
                    "name": s.host or s.server_id,
                    "host": s.host,
                    "username": s.username,
                    "ip": s.ip,
                    "hermes_version": meta.get("hermes_version"),
                    "components": meta.get("components", {}),
                    "host_updated_at": meta.get("updated_at"),
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
    def upsert(
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
        memory_available: bool | None = None,
        memory_provider: str | None = None,
        memory_endpoint: str | None = None,
        memory_agent: str | None = None,
        updated_at: float = 0,
    ) -> None:
        conn.execute(
            """
            INSERT INTO profile_info (
                host, username, ip, profile_name, path, gateway_status, session_count,
                total_tokens, total_input_tokens, total_output_tokens, cache_hit_rate,
                model_top5, provider_top5, daily_tokens, current_config_version,
                latest_config_version, memory_available, memory_provider,
                memory_endpoint, memory_agent, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                memory_available=excluded.memory_available,
                memory_provider=excluded.memory_provider,
                memory_endpoint=excluded.memory_endpoint,
                memory_agent=excluded.memory_agent,
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
                memory_available,
                memory_provider,
                memory_endpoint,
                memory_agent,
                updated_at,
            ),
        )

    @staticmethod
    def upsert_fast(
        conn,
        host: str | None,
        username: str | None,
        ip: str | None,
        profile_name: str,
        gateway_status: str | None,
        session_count: int,
        total_tokens: int,
        total_input_tokens: int,
        total_output_tokens: int,
        cache_hit_rate: float,
        updated_at: float,
    ) -> None:
        """Upsert only the fast-changing columns (gateway + token totals).

        Used by the 10-minute background cycle.  Slow-changing fields
        (model/provider top5, daily_tokens, config version, memory status)
        are left untouched — they're refreshed by the hourly full cycle.
        """
        conn.execute(
            """
            INSERT INTO profile_info (
                host, username, ip, profile_name,
                gateway_status, session_count, total_tokens,
                total_input_tokens, total_output_tokens, cache_hit_rate,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(host, username, ip, profile_name) DO UPDATE SET
                gateway_status=excluded.gateway_status,
                session_count=excluded.session_count,
                total_tokens=excluded.total_tokens,
                total_input_tokens=excluded.total_input_tokens,
                total_output_tokens=excluded.total_output_tokens,
                cache_hit_rate=excluded.cache_hit_rate,
                updated_at=excluded.updated_at
            """,
            (
                host,
                username,
                ip,
                profile_name,
                gateway_status,
                session_count,
                total_tokens,
                total_input_tokens,
                total_output_tokens,
                cache_hit_rate,
                updated_at,
            ),
        )


def _row_to_profile(row) -> Profile:
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
        model_top5=_load_json_field(row, "model_top5"),
        provider_top5=_load_json_field(row, "provider_top5"),
        daily_tokens=_load_json_field(row, "daily_tokens"),
        current_config_version=row["current_config_version"],
        latest_config_version=row["latest_config_version"],
        memory_available=row["memory_available"],
        memory_provider=row["memory_provider"],
        memory_endpoint=row["memory_endpoint"],
        memory_agent=row["memory_agent"],
        updated_at=row["updated_at"],
    )
