from __future__ import annotations

import json
import logging
import sqlite3
import time
from pathlib import Path

from passlib.hash import pbkdf2_sha256

from backend.config import Settings
from backend.db.models import User

logger = logging.getLogger(__name__)


CONTROL_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    profiles TEXT NOT NULL DEFAULT '[]',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS system_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp REAL NOT NULL,
    cpu_percent REAL,
    memory_percent REAL,
    memory_used_gb REAL,
    memory_total_gb REAL,
    disk_percent REAL,
    disk_used_gb REAL,
    disk_total_gb REAL,
    net_bytes_sent INTEGER,
    net_bytes_recv INTEGER,
    load_avg_1m REAL
);
CREATE INDEX IF NOT EXISTS idx_metrics_ts ON system_metrics(timestamp);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp REAL NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    details TEXT NOT NULL DEFAULT '{}',
    success INTEGER,
    ip_address TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
"""

PROFILES_SCHEMA = """
-- host_info: host-level metadata (hermes version, system component versions).
-- Refreshed once per hour by the full refresh cycle. One row per
-- (host, username, ip) so host metadata is no longer denormalised
-- across every profile row.
CREATE TABLE IF NOT EXISTS host_info (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host TEXT,
    username TEXT,
    ip TEXT,
    hermes_version TEXT,
    components TEXT NOT NULL DEFAULT '{}',
    updated_at REAL NOT NULL,
    UNIQUE(host, username, ip)
);
CREATE INDEX IF NOT EXISTS idx_host_info_lookup ON host_info(host, username, ip);
CREATE INDEX IF NOT EXISTS idx_host_info_updated ON host_info(updated_at);

-- profile_info: per-profile statistics (tokens, sessions, gateway status,
-- model/provider breakdowns, daily tokens, config version, memory status).
-- Fast-refreshed every 10 minutes (gateway + token totals) and fully
-- refreshed every 1 hour. Host-level columns are intentionally absent;
-- join to host_info on (host, username, ip) to recover them.
CREATE TABLE IF NOT EXISTS profile_info (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host TEXT,
    username TEXT,
    ip TEXT,
    profile_name TEXT NOT NULL,
    path TEXT,
    gateway_status TEXT,
    session_count INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_hit_rate REAL NOT NULL DEFAULT 0.0,
    model_top5 TEXT NOT NULL DEFAULT '[]',
    provider_top5 TEXT NOT NULL DEFAULT '[]',
    daily_tokens TEXT NOT NULL DEFAULT '[]',
    current_config_version INTEGER,
    latest_config_version INTEGER,
    memory_available INTEGER,
    memory_provider TEXT,
    memory_endpoint TEXT,
    memory_agent TEXT,
    updated_at REAL NOT NULL,
    UNIQUE(host, username, ip, profile_name)
);
CREATE INDEX IF NOT EXISTS idx_profile_info_host_user_ip ON profile_info(host, username, ip);
CREATE INDEX IF NOT EXISTS idx_profile_info_updated ON profile_info(updated_at);
"""


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=10000")
    return connection


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


def _column_exists(connection: sqlite3.Connection, table: str, column: str) -> bool:
    columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
    return column in columns


def _components_without_hermes(system_versions: dict | None) -> str:
    """Strip hermes from the components dict; hermes has its own column."""
    data = dict(system_versions) if system_versions else {}
    data.pop("hermes", None)
    return json.dumps(data)


def _migrate_legacy_to_split_tables(connection: sqlite3.Connection) -> None:
    """Merge legacy profile_stats + host_info into the new host_info/profile_info.

    Legacy schema had:
      - profile_stats: per-profile tokens/sessions (no host columns on older rows)
      - host_info: host-level hermes_version + system_versions

    New schema splits these into host_info (host-level) and profile_info
    (profile-level). This helper migrates the *oldest* legacy form.
    """
    if not _table_exists(connection, "profile_stats"):
        return

    host_info_rows = []
    if _table_exists(connection, "host_info"):
        host_info_rows = connection.execute(
            "SELECT host, username, ip, hermes_version, system_versions, updated_at FROM host_info"
        ).fetchall()

    def _find_host_info(host: str, username: str, ip: str):
        for h in host_info_rows:
            if h["host"] == host and h["username"] == username and h["ip"] == ip:
                return h
        return None

    # Copy host-level rows into host_info_new.
    for h in host_info_rows:
        system_versions = {}
        if h["system_versions"]:
            try:
                system_versions = json.loads(h["system_versions"])
            except Exception:
                system_versions = {}
        connection.execute(
            """
            INSERT OR IGNORE INTO host_info_new (
                host, username, ip, hermes_version, components, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                h["host"],
                h["username"],
                h["ip"],
                h["hermes_version"],
                _components_without_hermes(system_versions),
                h["updated_at"],
            ),
        )

    # Copy profile-level rows into profile_info_new, looking up host metadata
    # only to ensure the (host, username, ip) tuple exists in host_info_new.
    for row in connection.execute("SELECT * FROM profile_stats").fetchall():
        server_id = row["server_id"] or ""
        parts = server_id.split("|")
        host = parts[0] if len(parts) > 0 else row["host"]
        username = parts[1] if len(parts) > 1 else None
        ip = parts[2] if len(parts) > 2 else None

        hinfo = _find_host_info(host, username, ip)
        if hinfo is not None:
            # Ensure the host row is present even if the legacy host_info
            # table was missing this server (profile_stats carried server_id).
            connection.execute(
                """
                INSERT OR IGNORE INTO host_info_new (
                    host, username, ip, hermes_version, components, updated_at
                ) VALUES (?, ?, ?, ?, '{}', ?)
                """,
                (host, username, ip, hinfo["hermes_version"], row["updated_at"]),
            )

        connection.execute(
            """
            INSERT OR IGNORE INTO profile_info_new (
                host, username, ip, profile_name, path, gateway_status, session_count,
                total_tokens, total_input_tokens, total_output_tokens, cache_hit_rate,
                model_top5, provider_top5, daily_tokens, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                host,
                username,
                ip,
                row["profile_name"],
                row["path"],
                row["gateway_status"],
                row["session_count"],
                row["total_tokens"],
                row["total_input_tokens"],
                row["total_output_tokens"],
                row["cache_hit_rate"],
                row["model_top5"],
                row["provider_top5"],
                row["daily_tokens"],
                row["updated_at"],
            ),
        )

    connection.execute("DROP TABLE IF EXISTS profile_stats")
    connection.execute("DROP TABLE IF EXISTS host_info")


def _migrate_old_unified_profiles(connection: sqlite3.Connection) -> None:
    """Split an existing unified *profiles* table into host_info + profile_info.

    Handles both:
      - the recent unified schema (hermes_version + components already present)
      - older schema with hermes_home / system_versions columns
    """
    if not _table_exists(connection, "profiles"):
        return

    has_hermes_home = _column_exists(connection, "profiles", "hermes_home")
    has_system_versions = _column_exists(connection, "profiles", "system_versions")
    old_cols = {r[1] for r in connection.execute("PRAGMA table_info(profiles)")}

    # ---- host-level rows (one per host,username,ip) ----
    host_has_hermes_version = "hermes_version" in old_cols
    host_select = "SELECT host, username, ip"
    if host_has_hermes_version:
        host_select += ", hermes_version"
    if has_system_versions:
        host_select += ", system_versions"
    if "components" in old_cols:
        host_select += ", components"
    host_select += ", MAX(updated_at) AS updated_at FROM profiles GROUP BY host, username, ip"

    for row in connection.execute(host_select).fetchall():
        components = {}
        if has_system_versions and row["system_versions"]:
            try:
                components = json.loads(row["system_versions"])
            except Exception:
                components = {}
        elif "components" in old_cols and row["components"]:
            try:
                components = json.loads(row["components"])
            except Exception:
                components = {}
        connection.execute(
            """
            INSERT OR IGNORE INTO host_info_new (
                host, username, ip, hermes_version, components, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                row["host"],
                row["username"],
                row["ip"],
                row["hermes_version"] if host_has_hermes_version else None,
                _components_without_hermes(components),
                row["updated_at"],
            ),
        )

    # ---- profile-level rows ----
    profile_cols = {
        "id", "host", "username", "ip", "profile_name", "path", "gateway_status",
        "session_count", "total_tokens", "total_input_tokens", "total_output_tokens",
        "cache_hit_rate", "model_top5", "provider_top5", "daily_tokens",
        "current_config_version", "latest_config_version",
        "memory_available", "memory_provider", "memory_endpoint", "memory_agent",
        "updated_at",
    }
    if has_hermes_home:
        profile_cols.discard("hermes_home")
    if has_system_versions:
        profile_cols.discard("system_versions")
    profile_cols.discard("hermes_version")
    profile_shared = [c for c in old_cols & profile_cols if c != "id"]
    if profile_shared:
        cols = ", ".join(profile_shared)
        connection.executescript(
            f"INSERT OR IGNORE INTO profile_info_new ({cols}) SELECT {cols} FROM profiles"
        )


def init_database(settings: Settings) -> None:
    logger.info("init_database: initializing db at %s", settings.hermes_panel_db_path)
    with connect(settings.hermes_panel_db_path) as connection:
        connection.executescript(CONTROL_SCHEMA)

        # Build the new split tables (host_info + profile_info) under temporary
        # names, migrate data in, then swap them into place. PROFILES_SCHEMA
        # contains both table definitions; we use it for idempotent CREATE
        # after the swap (below) and hand-write the *_new temp schemas here
        # so the legacy host_info table can still be read during migration.
        host_only_schema = """
        CREATE TABLE IF NOT EXISTS host_info_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            host TEXT,
            username TEXT,
            ip TEXT,
            hermes_version TEXT,
            components TEXT NOT NULL DEFAULT '{}',
            updated_at REAL NOT NULL,
            UNIQUE(host, username, ip)
        );
        CREATE INDEX IF NOT EXISTS idx_host_info_lookup_new ON host_info_new(host, username, ip);
        CREATE INDEX IF NOT EXISTS idx_host_info_updated_new ON host_info_new(updated_at);
        """
        profile_only_schema = """
        CREATE TABLE IF NOT EXISTS profile_info_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            host TEXT,
            username TEXT,
            ip TEXT,
            profile_name TEXT NOT NULL,
            path TEXT,
            gateway_status TEXT,
            session_count INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            total_input_tokens INTEGER NOT NULL DEFAULT 0,
            total_output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_hit_rate REAL NOT NULL DEFAULT 0.0,
            model_top5 TEXT NOT NULL DEFAULT '[]',
            provider_top5 TEXT NOT NULL DEFAULT '[]',
            daily_tokens TEXT NOT NULL DEFAULT '[]',
            current_config_version INTEGER,
            latest_config_version INTEGER,
            memory_available INTEGER,
            memory_provider TEXT,
            memory_endpoint TEXT,
            memory_agent TEXT,
            updated_at REAL NOT NULL,
            UNIQUE(host, username, ip, profile_name)
        );
        CREATE INDEX IF NOT EXISTS idx_profile_info_host_user_ip_new ON profile_info_new(host, username, ip);
        CREATE INDEX IF NOT EXISTS idx_profile_info_updated_new ON profile_info_new(updated_at);
        """
        connection.executescript(host_only_schema)
        connection.executescript(profile_only_schema)

        _migrate_legacy_to_split_tables(connection)
        _migrate_old_unified_profiles(connection)

        # Drop the legacy unified profiles table; the new split tables take over.
        connection.execute("DROP TABLE IF EXISTS profiles")
        # Swap temp tables into their final names.
        connection.execute("DROP TABLE IF EXISTS host_info")
        connection.execute("ALTER TABLE host_info_new RENAME TO host_info")
        connection.execute("DROP INDEX IF EXISTS idx_host_info_lookup_new")
        connection.execute("DROP INDEX IF EXISTS idx_host_info_updated_new")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_host_info_lookup ON host_info(host, username, ip)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_host_info_updated ON host_info(updated_at)")

        connection.execute("DROP TABLE IF EXISTS profile_info")
        connection.execute("ALTER TABLE profile_info_new RENAME TO profile_info")
        connection.execute("DROP INDEX IF EXISTS idx_profile_info_host_user_ip_new")
        connection.execute("DROP INDEX IF EXISTS idx_profile_info_updated_new")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_profile_info_host_user_ip ON profile_info(host, username, ip)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_profile_info_updated ON profile_info(updated_at)")

        # Final idempotent pass: PROFILES_SCHEMA uses CREATE IF NOT EXISTS,
        # so this is a no-op when the swap above already created the tables
        # (fresh or migrated), and it guarantees the tables exist for code
        # paths that skip migration (e.g. tests with their own settings).
        connection.executescript(PROFILES_SCHEMA)

        existing = connection.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if existing == 0:
            logger.info("init_database: creating default admin user")
            now = time.time()
            connection.execute(
                """
                INSERT INTO users (username, password_hash, role, profiles, created_at, updated_at)
                VALUES (?, ?, 'admin', ?, ?, ?)
                """,
                ("admin", hash_password(settings.default_admin_password), json.dumps(["*"]), now, now),
            )

    logger.info("init_database: db initialized successfully")


def hash_password(password: str) -> str:
    return pbkdf2_sha256.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pbkdf2_sha256.verify(password, password_hash)


def row_to_user(row: sqlite3.Row | None) -> User | None:
    if row is None:
        return None
    return User(
        id=row["id"],
        username=row["username"],
        password_hash=row["password_hash"],
        role=row["role"],
        profiles=json.loads(row["profiles"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )