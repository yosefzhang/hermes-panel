"""Audit log service for tracking panel operations.

Records both local actions (gateway start/stop/restart) and federation
actions (agent registration, command dispatch) in the same SQLite database
used by the rest of the panel.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

from backend.config import Settings
from backend.db.database import connect


@dataclass
class AuditLog:
    id: int
    timestamp: float
    actor: str
    action: str
    target_type: str | None
    target_id: str | None
    details: dict
    success: bool | None
    ip_address: str | None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "timestamp": self.timestamp,
            "actor": self.actor,
            "action": self.action,
            "target_type": self.target_type,
            "target_id": self.target_id,
            "details": self.details,
            "success": self.success,
            "ip_address": self.ip_address,
        }


def log_audit_event(
    settings: Settings,
    action: str,
    actor: str,
    *,
    target_type: str | None = None,
    target_id: str | None = None,
    details: dict | None = None,
    success: bool | None = None,
    ip_address: str | None = None,
) -> int:
    """Persist a single audit log entry and return its row id."""
    now = time.time()
    with connect(settings.hermes_panel_db_path) as conn:
        cursor = conn.execute(
            """
            INSERT INTO audit_logs
            (timestamp, actor, action, target_type, target_id, details, success, ip_address)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                now,
                actor,
                action,
                target_type,
                target_id,
                json.dumps(details or {}),
                1 if success is True else 0 if success is False else None,
                ip_address,
            ),
        )
        return cursor.lastrowid or 0


def get_audit_logs(
    settings: Settings,
    *,
    limit: int = 100,
    offset: int = 0,
    action: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
) -> list[AuditLog]:
    """Return recent audit log entries, newest first."""
    where: list[str] = []
    params: list[str | int] = []
    if action:
        where.append("action = ?")
        params.append(action)
    if target_type:
        where.append("target_type = ?")
        params.append(target_type)
    if target_id:
        where.append("target_id = ?")
        params.append(target_id)

    sql = "SELECT * FROM audit_logs"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY timestamp DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    with connect(settings.hermes_panel_db_path) as conn:
        rows = conn.execute(sql, params).fetchall()
    return [_row_to_log(row) for row in rows]


def _row_to_log(row) -> AuditLog:
    details = {}
    try:
        details = json.loads(row["details"])
    except Exception:
        pass
    success = None
    if row["success"] is not None:
        success = bool(row["success"])
    return AuditLog(
        id=row["id"],
        timestamp=row["timestamp"],
        actor=row["actor"],
        action=row["action"],
        target_type=row["target_type"],
        target_id=row["target_id"],
        details=details,
        success=success,
        ip_address=row["ip_address"],
    )
