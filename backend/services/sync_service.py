"""Cross-panel data sync service.

Sends local profiles (stats + host metadata) to a configured target panel, and
accepts incoming sync payloads from other panels to store in the local DB.
"""
from __future__ import annotations

import json
import logging
import secrets
import string
import time

import certifi
import urllib3

from backend.config import Settings, update_config_file
from backend.db.database import connect
from backend.services.host_info_service import HostInfoService, make_server_id
from backend.services.profile_stats_service import ProfileStatsService

logger = logging.getLogger(__name__)

# In-memory state for the receive sync "process".  Receive sync is implemented
# as the FastAPI endpoint POST /sync/, so there is no separate OS process, but
# we still track when it was enabled and the last payload it accepted so the UI
# can display "process" status.
_receive_state: dict = {
    "enabled_at": None,
    "last_received_at": None,
    "last_profiles_count": 0,
    "last_hosts_count": 0,
    "total_payloads": 0,
}

# In-memory state for the send sync "process".  Send sync is not a separate
# process or a heartbeat: the main FastAPI process runs a periodic loop that,
# when enabled, does one push at the configured interval and records the
# outcome here so the UI can show counters and the last push result.
_send_state: dict = {
    "enabled": False,
    "last_push_at": None,
    "last_push_ok": None,
    "last_push_message": None,
    "total_pushes": 0,
    "total_successes": 0,
    "total_failures": 0,
}


def set_receive_enabled(enabled: bool) -> None:
    """Update receive-sync runtime state when the setting is toggled."""
    if enabled and _receive_state["enabled_at"] is None:
        _receive_state["enabled_at"] = time.time()
        logger.info("Receive sync enabled - now accepting incoming sync payloads")
    elif not enabled and _receive_state["enabled_at"] is not None:
        _receive_state["enabled_at"] = None
        logger.info("Receive sync disabled - no longer accepting incoming sync payloads")


def set_send_enabled(enabled: bool) -> None:
    """Update send-sync runtime state when the setting is toggled."""
    if enabled and not _send_state["enabled"]:
        _send_state["enabled"] = True
        logger.info("Send sync enabled - now pushing local stats to target panel")
    elif not enabled and _send_state["enabled"]:
        _send_state["enabled"] = False
        logger.info("Send sync disabled - no longer pushing to target panel")


def initialize_receive_state_from_settings(settings: Settings) -> None:
    """Restore receive-sync runtime state from persisted settings on startup."""
    if settings.sync_receive_enabled and _receive_state["enabled_at"] is None:
        _receive_state["enabled_at"] = time.time()
        logger.info("Receive sync restored from settings - now accepting incoming sync payloads")


def initialize_send_state_from_settings(settings: Settings) -> None:
    """Restore send-sync runtime state from persisted settings on startup."""
    if settings.sync_enabled and not _send_state["enabled"]:
        _send_state["enabled"] = True
        logger.info("Send sync restored from settings - now pushing to target panel")


def record_push_result(ok: bool, message: str | None = None) -> None:
    """Record the outcome of a sync push attempt."""
    _send_state["last_push_at"] = time.time()
    _send_state["last_push_ok"] = ok
    _send_state["last_push_message"] = message
    _send_state["total_pushes"] += 1
    if ok:
        _send_state["total_successes"] += 1
    else:
        _send_state["total_failures"] += 1


def ensure_receive_token(settings: Settings) -> str:
    """Return the configured receive token.

    When none is configured, generate a random 16-character token, persist it
    to config.yaml and update the in-memory settings so senders always have a
    stable token to authenticate with.
    """
    if settings.sync_receive_token:
        return settings.sync_receive_token
    alphabet = string.ascii_letters + string.digits
    token = "".join(secrets.choice(alphabet) for _ in range(16))
    try:
        update_config_file({"sync": {"receive": {"token": token}}})
    except Exception:
        logger.exception("ensure_receive_token: failed to persist generated token")
    settings.sync_receive_token = token
    logger.info("ensure_receive_token: generated a new 16-char receive token")
    return token


def get_receive_status() -> dict:
    """Return current receive-sync runtime status."""
    enabled_at = _receive_state["enabled_at"]
    return {
        "enabled": enabled_at is not None,
        "enabled_at": enabled_at,
        "uptime_seconds": round(time.time() - enabled_at, 1) if enabled_at else 0,
        "last_received_at": _receive_state["last_received_at"],
        "last_profiles_count": _receive_state["last_profiles_count"],
        "last_hosts_count": _receive_state["last_hosts_count"],
        "total_payloads": _receive_state["total_payloads"],
    }


def get_send_status() -> dict:
    """Return current send-sync runtime status."""
    return {
        "enabled": _send_state["enabled"],
        "last_push_at": _send_state["last_push_at"],
        "last_push_ok": _send_state["last_push_ok"],
        "last_push_message": _send_state["last_push_message"],
        "total_pushes": _send_state["total_pushes"],
        "total_successes": _send_state["total_successes"],
        "total_failures": _send_state["total_failures"],
    }


class SyncService:
    """Push local stats to another panel and/or ingest remote panel stats."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.db_path = settings.hermes_panel_db_path
        self._http = urllib3.PoolManager(
            cert_reqs="CERT_REQUIRED",
            ca_certs=certifi.where(),
            timeout=urllib3.Timeout(connect=5, read=30),
        )

    def _target_url(self) -> str:
        """Return the configured sync endpoint, with legacy base URL support."""
        target = (self.settings.sync_target_url or "").rstrip("/")
        if target.endswith("/api/v1/sync"):
            return f"{target}/"
        return f"{target}/api/v1/sync/"

    def _send_endpoints(self) -> list[dict]:
        if self.settings.sync_send_endpoints:
            return self.settings.sync_send_endpoints
        if self.settings.sync_target_url:
            return [{"endpoint": self.settings.sync_target_url, "token": self.settings.sync_send_token}]
        return []

    def _headers(self, token: str | None = None) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        token = token if token is not None else self.settings.sync_send_token
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def push(self) -> dict:
        """Collect local stats and host info and POST them to the target panel."""
        endpoints = self._send_endpoints()
        if not self.settings.sync_enabled or not endpoints:
            return {"ok": False, "message": "sync not configured"}

        payload = self._collect_payload()
        results = []
        for item in endpoints:
            target = item.get("endpoint") or item.get("url")
            if not target:
                continue
            url = self._normalize_target_url(str(target))
            token = item.get("token")
            logger.info("Sync push starting: url=%s profiles=%d hosts=%d", url, len(payload.get("profiles", [])), len(payload.get("hosts", [])))
            try:
                response = self._http.request("POST", url, body=json.dumps(payload).encode("utf-8"), headers=self._headers(token))
                status = response.status
                message = response.data.decode("utf-8", errors="ignore")[:500]
                results.append({"endpoint": url, "ok": status == 200, "status": status, "message": message})
            except Exception:
                logger.exception("Sync push to %s failed", url)
                results.append({"endpoint": url, "ok": False, "message": "network error"})
        ok = bool(results) and all(item["ok"] for item in results)
        return {"ok": ok, "results": results, "message": None if ok else "one or more sync endpoints failed"}

    def _normalize_target_url(self, target: str) -> str:
        target = target.rstrip("/")
        return f"{target}/" if target.endswith("/api/v1/sync") else f"{target}/api/v1/sync/"

    def _collect_payload(self) -> dict:
        """Gather everything this panel wants to share with its target."""
        stats_service = ProfileStatsService(self.settings)
        host_service = HostInfoService(self.settings)

        stats_service.cleanup_stale_records()
        profiles = [s.to_dict() for s in stats_service.get_all_stats()]
        hosts = [h.to_dict() for h in host_service.get_all_host_info()]

        # Identify this panel by its own local host record.  The top-level
        # server_id is informational; individual rows keep their own server_id.
        local_hosts = [h for h in hosts if h.get("host")]
        local_server_id = "local"
        if local_hosts:
            local_server_id = make_server_id(
                local_hosts[0].get("host", ""),
                local_hosts[0].get("username", ""),
                local_hosts[0].get("ip", ""),
            )

        return {
            "server_id": local_server_id,
            "profiles": profiles,
            "hosts": hosts,
            "synced_at": time.time(),
        }

    def ingest(self, payload: dict) -> dict:
        """Store an incoming sync payload into the local database.

        The payload carries two independent collections:
          - ``hosts``:  host-level metadata → written to the host_info table
          - ``profiles``: profile-level statistics → written to profile_info
        Previously both were crammed into a single ``profiles`` row; the split
        schema keeps them in their own tables and lets host info refresh on the
        1 h cadence while profile stats refresh on the 10 min cadence.
        """
        if not self.settings.sync_receive_enabled:
            raise ValueError("sync receive is disabled on this panel")
        profiles = payload.get("profiles", [])
        hosts = payload.get("hosts", [])

        with connect(self.db_path) as conn:
            # --- host_info: one row per (host, username, ip) ---
            for h in hosts:
                host = h.get("host")
                username = h.get("username")
                ip = h.get("ip")
                if username is None or ip is None:
                    server_id = h.get("server_id", "")
                    parts = server_id.split("|")
                    if host is None and len(parts) > 0:
                        host = parts[0]
                    if username is None and len(parts) > 1:
                        username = parts[1]
                    if ip is None and len(parts) > 2:
                        ip = parts[2]
                components = dict(
                    h.get("components") or h.get("system_versions") or {}
                )
                conn.execute(
                    """
                    INSERT INTO host_info (host, username, ip, hermes_version, components, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(host, username, ip) DO UPDATE SET
                        hermes_version=excluded.hermes_version,
                        components=excluded.components,
                        updated_at=excluded.updated_at
                    """,
                    (
                        host,
                        username,
                        ip,
                        h.get("hermes_version"),
                        json.dumps(components),
                        h.get("updated_at", time.time()),
                    ),
                )

            # --- profile_info: one row per (host, username, ip, profile_name) ---
            for p in profiles:
                host = p.get("host")
                username = p.get("username")
                ip = p.get("ip")
                if username is None or ip is None:
                    server_id = p.get("server_id", "")
                    parts = server_id.split("|")
                    if host is None and len(parts) > 0:
                        host = parts[0]
                    if username is None and len(parts) > 1:
                        username = parts[1]
                    if ip is None and len(parts) > 2:
                        ip = parts[2]

                ProfileStatsService.upsert(
                    conn,
                    host=host,
                    username=username,
                    ip=ip,
                    profile_name=p.get("profile_name", ""),
                    path=p.get("path"),
                    gateway_status=p.get("gateway_status"),
                    session_count=int(p.get("session_count", 0)),
                    total_tokens=int(p.get("total_tokens", 0)),
                    total_input_tokens=int(p.get("total_input_tokens", 0)),
                    total_output_tokens=int(p.get("total_output_tokens", 0)),
                    cache_hit_rate=float(p.get("cache_hit_rate", 0.0)),
                    model_top5=p.get("model_top5", []),
                    provider_top5=p.get("provider_top5", []),
                    daily_tokens=p.get("daily_tokens", []),
                    current_config_version=p.get("current_config_version"),
                    latest_config_version=p.get("latest_config_version"),
                    memory_available=p.get("memory_available"),
                    memory_provider=p.get("memory_provider"),
                    memory_endpoint=p.get("memory_endpoint"),
                    memory_agent=p.get("memory_agent"),
                    updated_at=p.get("updated_at", time.time()),
                )

        _receive_state["last_received_at"] = time.time()
        _receive_state["last_profiles_count"] = len(profiles)
        _receive_state["last_hosts_count"] = len(hosts)
        _receive_state["total_payloads"] += 1

        logger.info(
            "Sync payload received: profiles=%d hosts=%d total_payloads=%d",
            len(profiles),
            len(hosts),
            _receive_state["total_payloads"],
        )

        return {"ok": True, "profiles": len(profiles), "hosts": len(hosts)}
