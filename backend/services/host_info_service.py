from __future__ import annotations

import json
import logging
import os
import pwd
import socket
import time
from dataclasses import dataclass
from pathlib import Path

from backend.config import Settings
from backend.db.database import connect
from backend.services.hermes_info_service import HermesInfoService

logger = logging.getLogger(__name__)


def get_username() -> str:
    """Return the current Linux user name."""
    try:
        return pwd.getpwuid(os.getuid()).pw_name
    except Exception:
        return os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"


def get_primary_ip() -> str:
    """Return the machine's primary non-loopback IPv4 address."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return socket.gethostbyname(socket.gethostname()) or "127.0.0.1"


def make_server_id(host: str, username: str, ip: str) -> str:
    """Create a unique server id from hostname, username and IP address."""
    return f"{host}|{username}|{ip}"


@dataclass
class HostInfo:
    host: str | None
    username: str | None
    ip: str | None
    hermes_version: str | None
    hermes_home: str | None
    components: dict
    updated_at: float

    def to_dict(self) -> dict:
        return {
            "host": self.host,
            "username": self.username,
            "ip": self.ip,
            "hermes_version": self.hermes_version,
            "hermes_home": self.hermes_home,
            # Keep ``system_versions`` as an alias in the payload for
            # backwards-compatible sync consumers; the DB column is
            # ``components``.
            "system_versions": self.components,
            "components": self.components,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_row(cls, row: dict) -> "HostInfo":
        components = json.loads(row["components"] or "{}")
        return cls(
            host=row["host"],
            username=row["username"],
            ip=row["ip"],
            hermes_version=row["hermes_version"],
            hermes_home=None,
            components=components,
            updated_at=row["updated_at"],
        )


class HostInfoService:
    """Service for collecting and querying host-level metadata."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.db_path = settings.hermes_panel_db_path

    def collect_local_host_info(self) -> HostInfo:
        """Gather local host metadata from Hermes CLI and system tools."""
        info_svc = HermesInfoService(self.settings.hermes_home, settings=self.settings)
        versions = info_svc.get_system_versions()
        home_info = info_svc.get_hermes_home_info()
        host = socket.gethostname()
        username = get_username()
        ip = get_primary_ip()
        return HostInfo(
            host=host,
            username=username,
            ip=ip,
            hermes_version=versions.get("hermes"),
            hermes_home=home_info.get("path"),
            components=versions,
            updated_at=time.time(),
        )

    def _upsert(self, conn, info: HostInfo) -> None:
        # host_info is now a standalone table (one row per host, username, ip).
        # We own the INSERT here — ProfileStatsService no longer touches host
        # columns. INSERT ... ON CONFLICT keeps the row when it already exists
        # and only refreshes hermes_version, components, updated_at.
        components = dict(info.components) if info.components else {}
        return conn.execute(
            """
            INSERT INTO host_info (host, username, ip, hermes_version, components, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(host, username, ip) DO UPDATE SET
                hermes_version=excluded.hermes_version,
                components=excluded.components,
                updated_at=excluded.updated_at
            """,
            (
                info.host,
                info.username,
                info.ip,
                info.hermes_version,
                json.dumps(components),
                info.updated_at,
            ),
        )

    def refresh_local(self) -> HostInfo:
        """Collect and store local host info in the panel DB (host_info table)."""
        info = self.collect_local_host_info()
        with connect(self.db_path) as conn:
            cur = self._upsert(conn, info)
        logger.info(
            "host_info refresh_local: upserted host=%s user=%s ip=%s "
            "hermes_version=%s components=%d",
            info.host, info.username, info.ip,
            info.hermes_version,
            len({k: v for k, v in (info.components or {}).items() if k != 'hermes'}),
        )
        return info

    def get_all_host_info(self) -> list[HostInfo]:
        """Return host info for all known servers (local + children).

        With the split schema, host_info is its own table; one row per
        server already, no GROUP BY collapse needed.
        """
        with connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT host, username, ip, hermes_version, components, updated_at "
                "FROM host_info ORDER BY updated_at DESC"
            ).fetchall()
        return [HostInfo.from_row(row) for row in rows]
