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
CREATE TABLE IF NOT EXISTS profiles (
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
    hermes_version TEXT,
    components TEXT NOT NULL DEFAULT '{}',
    current_config_version INTEGER,
    latest_config_version INTEGER,
    memory_available INTEGER,
    memory_provider TEXT,
    memory_endpoint TEXT,
    memory_agent TEXT,
    updated_at REAL NOT NULL,
    UNIQUE(host, username, ip, profile_name)
);
CREATE INDEX IF NOT EXISTS idx_profiles_host_user_ip ON profiles(host, username, ip);
CREATE INDEX IF NOT EXISTS idx_profiles_updated ON profiles(updated_at);
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


def _migrate_legacy_to_new_profiles(connection: sqlite3.Connection) -> None:
    """Merge legacy profile_stats + host_info into the unified profiles table."""
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

    for row in connection.execute("SELECT * FROM profile_stats").fetchall():
        server_id = row["server_id"] or ""
        parts = server_id.split("|")
        host = parts[0] if len(parts) > 0 else row["host"]
        username = parts[1] if len(parts) > 1 else None
        ip = parts[2] if len(parts) > 2 else None
        hinfo = _find_host_info(host, username, ip)
        system_versions = {}
        if hinfo and hinfo["system_versions"]:
            try:
                system_versions = json.loads(hinfo["system_versions"])
            except Exception:
                system_versions = {}

        connection.execute(
            """
            INSERT OR IGNORE INTO profiles_new (
                host, username, ip, profile_name, path, gateway_status, session_count,
                total_tokens, total_input_tokens, total_output_tokens, cache_hit_rate,
                model_top5, provider_top5, daily_tokens, hermes_version, components,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                hinfo["hermes_version"] if hinfo else None,
                _components_without_hermes(system_versions),
                row["updated_at"],
            ),
        )

    connection.execute("DROP TABLE IF EXISTS profile_stats")
    connection.execute("DROP TABLE IF EXISTS host_info")


def _migrate_old_profiles(connection: sqlite3.Connection) -> None:
    """Migrate an existing profiles table from the hermes_home/system_versions schema."""
    has_hermes_home = _column_exists(connection, "profiles", "hermes_home")
    has_system_versions = _column_exists(connection, "profiles", "system_versions")

    # The table already matches the current schema shape (no legacy columns).
    # Copy existing rows straight into profiles_new so the DROP+RENAME swap
    # below doesn't wipe live data. New columns absent from the old table
    # (e.g. current_config_version) default to NULL and are filled by the
    # next stats collection cycle.
    if not has_hermes_home and not has_system_versions:
        old_cols = {r[1] for r in connection.execute("PRAGMA table_info(profiles)")}
        new_cols = {r[1] for r in connection.execute("PRAGMA table_info(profiles_new)")}
        shared = [c for c in old_cols & new_cols if c != "id"]
        if shared:
            cols = ", ".join(shared)
            connection.execute(
                f"INSERT OR IGNORE INTO profiles_new ({cols}) SELECT {cols} FROM profiles"
            )
        return

    columns = [
        "id",
        "host",
        "username",
        "ip",
        "profile_name",
        "path",
        "gateway_status",
        "session_count",
        "total_tokens",
        "total_input_tokens",
        "total_output_tokens",
        "cache_hit_rate",
        "model_top5",
        "provider_top5",
        "daily_tokens",
        "hermes_version",
        "updated_at",
    ]
    if has_hermes_home:
        columns.append("hermes_home")
    if has_system_versions:
        columns.append("system_versions")

    select_sql = f"SELECT {', '.join(columns)} FROM profiles"
    for row in connection.execute(select_sql).fetchall():
        system_versions = {}
        if has_system_versions and row["system_versions"]:
            try:
                system_versions = json.loads(row["system_versions"])
            except Exception:
                system_versions = {}

        connection.execute(
            """
            INSERT OR REPLACE INTO profiles_new (
                host, username, ip, profile_name, path, gateway_status, session_count,
                total_tokens, total_input_tokens, total_output_tokens, cache_hit_rate,
                model_top5, provider_top5, daily_tokens, hermes_version, components,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["host"],
                row["username"],
                row["ip"],
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
                row["hermes_version"],
                _components_without_hermes(system_versions),
                row["updated_at"],
            ),
        )


def init_database(settings: Settings) -> None:
    logger.info("init_database: initializing db at %s", settings.hermes_panel_db_path)
    with connect(settings.hermes_panel_db_path) as connection:
        connection.executescript(CONTROL_SCHEMA)

        # SQLite makes it awkward to drop/rename columns, so we build the new
        # profiles table under a temporary name and swap it in.
        temp_schema = PROFILES_SCHEMA.replace("profiles", "profiles_new").replace(
            "idx_profiles_host_user_ip", "idx_profiles_host_user_ip_new"
        ).replace("idx_profiles_updated", "idx_profiles_updated_new")
        connection.executescript(temp_schema)

        _migrate_legacy_to_new_profiles(connection)
        _migrate_old_profiles(connection)

        connection.execute("DROP TABLE IF EXISTS profiles")
        connection.execute("ALTER TABLE profiles_new RENAME TO profiles")
        connection.execute("DROP INDEX IF EXISTS idx_profiles_host_user_ip_new")
        connection.execute("DROP INDEX IF EXISTS idx_profiles_updated_new")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_profiles_host_user_ip ON profiles(host, username, ip)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_profiles_updated ON profiles(updated_at)")

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