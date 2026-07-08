from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from passlib.hash import pbkdf2_sha256

from backend.config import Settings
from backend.db.models import User


SCHEMA = """
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
"""


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    return connection


def init_database(settings: Settings) -> None:
    with connect(settings.control_db_path) as connection:
        connection.executescript(SCHEMA)
        existing = connection.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if existing == 0:
            now = time.time()
            connection.execute(
                """
                INSERT INTO users (username, password_hash, role, profiles, created_at, updated_at)
                VALUES (?, ?, 'admin', ?, ?, ?)
                """,
                ("admin", hash_password(settings.default_admin_password), json.dumps(["*"]), now, now),
            )


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