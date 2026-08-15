from __future__ import annotations

import logging
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

from .profile_service import ProfileService

logger = logging.getLogger(__name__)


def _table_exists(connection: sqlite3.Connection, name: str) -> bool:
    """Return True iff *name* is a user table in the given connection."""
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    ).fetchone()
    return row is not None


class StateReader:
    def __init__(self, hermes_home: Path | None = None):
        self.profiles = ProfileService(hermes_home=hermes_home)

    def aggregate_token_stats(self, profile: str | None = None, days: int = 30) -> dict:
        db_path = self.profiles.get_state_db_path(profile)
        if not db_path.exists():
            logger.debug("aggregate_token_stats: state.db not found for profile=%s path=%s", profile, db_path)
            return {
                "total_input_tokens": 0,
                "total_output_tokens": 0,
                "total_cost_usd": 0.0,
                "by_model": [],
                "daily": [],
            }

        logger.debug("aggregate_token_stats: reading profile=%s days=%d", profile, days)
        cutoff = (datetime.now() - timedelta(days=days)).timestamp()
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as connection:
            connection.row_factory = sqlite3.Row
            rows = connection.execute(
                """
                SELECT
                    date(started_at, 'unixepoch') AS day,
                    model,
                    billing_provider AS provider,
                    SUM(input_tokens) AS total_input,
                    SUM(output_tokens) AS total_output,
                    SUM(cache_read_tokens) AS total_cache_read,
                    SUM(cache_write_tokens) AS total_cache_write,
                    SUM(reasoning_tokens) AS total_reasoning,
                    COUNT(*) AS session_count,
                    SUM(estimated_cost_usd) AS total_cost
                FROM sessions
                WHERE started_at >= ?
                GROUP BY day, model, provider
                ORDER BY day DESC
                """,
                (cutoff,),
            ).fetchall()

        by_model: dict[str, dict] = {}
        daily: dict[str, dict] = {}
        for row in rows:
            model = row["model"] or "unknown"
            day = row["day"]
            model_stats = by_model.setdefault(
                model,
                {"model": model, "provider": row["provider"], "input_tokens": 0, "output_tokens": 0, "cost": 0.0, "sessions": 0},
            )
            model_stats["input_tokens"] += row["total_input"] or 0
            model_stats["output_tokens"] += row["total_output"] or 0
            model_stats["cost"] += row["total_cost"] or 0.0
            model_stats["sessions"] += row["session_count"] or 0
            daily.setdefault(day, {})[model] = {
                "input_tokens": row["total_input"] or 0,
                "output_tokens": row["total_output"] or 0,
                "cost": row["total_cost"] or 0.0,
                "sessions": row["session_count"] or 0,
            }

        models = list(by_model.values())
        logger.debug(
            "aggregate_token_stats: profile=%s models=%d daily_days=%d total_tokens=%d",
            profile, len(models), len(daily),
            sum(item["input_tokens"] + item["output_tokens"] for item in models),
        )
        return {
            "total_input_tokens": sum(item["input_tokens"] for item in models),
            "total_output_tokens": sum(item["output_tokens"] for item in models),
            "total_cost_usd": round(sum(item["cost"] for item in models), 6),
            "by_model": models,
            "daily": [{"date": day, "models": values} for day, values in sorted(daily.items())],
        }

    def get_dashboard_data(self, profile: str | None = None) -> dict:
        db_path = self.profiles.get_state_db_path(profile)
        empty = {
            "summary": {
                "total_sessions": 0,
                "total_input_tokens": 0,
                "total_output_tokens": 0,
                "total_cache_read": 0,
                "total_cache_write": 0,
                "total_tokens": 0,
                "total_cost_usd": 0.0,
                "cache_hit_rate": 0.0,
            },
            "by_model": [],
            "by_provider": [],
            "daily": [],
        }
        if not db_path.exists():
            logger.debug("get_dashboard_data: state.db not found for profile=%s path=%s", profile, db_path)
            return empty

        logger.debug("get_dashboard_data: reading profile=%s db=%s", profile, db_path)

        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as connection:
            connection.row_factory = sqlite3.Row

            # Prefer ``session_model_usage`` (real-time per-request accounting
            # that includes in-progress sessions) when available.  Legacy
            # installs whose ``state.db`` predates the per-model accounting
            # table fall back to the ``sessions`` aggregate.
            has_usage_table = _table_exists(connection, "session_model_usage")
            source_table = "session_model_usage" if has_usage_table else "sessions"
            logger.debug("get_dashboard_data: profile=%s using source=%s", profile, source_table)

            summary = self._read_summary(connection, has_usage_table)
            daily = self._read_daily(connection, has_usage_table)
            by_model = self._read_by_model(connection, has_usage_table)
            by_provider = self._read_by_provider(connection, has_usage_table)

            total_tokens = summary["total_input_tokens"] + summary["total_output_tokens"]
            summary["total_tokens"] = total_tokens
            summary["total_cost_usd"] = round(summary["total_cost"], 6)
            total_input_all = summary["total_input_tokens"] + summary["total_cache_read"]
            summary["cache_hit_rate"] = round(summary["total_cache_read"] / total_input_all * 100, 1) if total_input_all > 0 else 0.0

            logger.debug(
                "get_dashboard_data: profile=%s days=%d today(%s)=%d top_model=%s(%d tokens)",
                profile, len(daily), datetime.now().strftime("%Y-%m-%d"),
                next((d["total_tokens"] for d in daily if d["day"] == datetime.now().strftime("%Y-%m-%d")), 0),
                by_model[0]["model"] if by_model else "N/A",
                by_model[0]["total_tokens"] if by_model else 0,
            )

        return {
            "summary": summary,
            "by_model": by_model,
            "by_provider": by_provider,
            "daily": daily,
        }

    def _read_summary(self, connection: sqlite3.Connection, has_usage_table: bool) -> dict:
        """Read summary statistics from the appropriate source table."""
        if has_usage_table:
            return dict(
                connection.execute(
                    """
                    SELECT
                        COUNT(DISTINCT session_id) AS total_sessions,
                        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                        COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
                        COALESCE(SUM(cache_write_tokens), 0) AS total_cache_write,
                        COALESCE(SUM(estimated_cost_usd), 0) AS total_cost
                    FROM session_model_usage
                    """
                ).fetchone()
            )
        return dict(
            connection.execute(
                """
                SELECT
                    COUNT(*) AS total_sessions,
                    COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                    COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                    COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
                    COALESCE(SUM(cache_write_tokens), 0) AS total_cache_write,
                    COALESCE(SUM(estimated_cost_usd), 0) AS total_cost
                FROM sessions
                """
            ).fetchone()
        )

    def _read_daily(self, connection: sqlite3.Connection, has_usage_table: bool) -> list[dict]:
        """Read daily token usage from the appropriate source table."""
        if has_usage_table:
            return [
                dict(r)
                for r in connection.execute(
                    """
                    SELECT
                        date(last_seen, 'unixepoch') AS day,
                        COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
                        COALESCE(SUM(input_tokens), 0) AS input_tokens,
                        COALESCE(SUM(output_tokens), 0) AS output_tokens
                    FROM session_model_usage
                    WHERE last_seen IS NOT NULL
                    GROUP BY day
                    ORDER BY day
                    """
                ).fetchall()
            ]
        return [
            dict(r)
            for r in connection.execute(
                """
                SELECT
                    date(started_at, 'unixepoch') AS day,
                    COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
                    COALESCE(SUM(input_tokens), 0) AS input_tokens,
                    COALESCE(SUM(output_tokens), 0) AS output_tokens
                FROM sessions
                GROUP BY day
                ORDER BY day
                """
            ).fetchall()
        ]

    def _read_by_model(self, connection: sqlite3.Connection, has_usage_table: bool) -> list[dict]:
        """Read model-level breakdown from the appropriate source table."""
        if has_usage_table:
            return [
                {
                    "model": r["model"] or "unknown",
                    "total_tokens": r["total_input_tokens"] + r["total_output_tokens"],
                    "sessions": r["sessions"],
                }
                for r in connection.execute(
                    """
                    SELECT
                        model,
                        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                        COUNT(DISTINCT session_id) AS sessions
                    FROM session_model_usage
                    GROUP BY model
                    ORDER BY (total_input_tokens + total_output_tokens) DESC
                    """
                ).fetchall()
            ]
        return [
            {
                "model": r["model"] or "unknown",
                "total_tokens": r["total_input_tokens"] + r["total_output_tokens"],
                "sessions": r["sessions"],
            }
            for r in connection.execute(
                """
                SELECT
                    model,
                    COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                    COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                    COUNT(*) AS sessions
                FROM sessions
                GROUP BY model
                ORDER BY (total_input_tokens + total_output_tokens) DESC
                """
            ).fetchall()
        ]

    def _read_by_provider(self, connection: sqlite3.Connection, has_usage_table: bool) -> list[dict]:
        """Read provider-level breakdown from the appropriate source table."""
        if has_usage_table:
            return [
                {
                    "provider": r["provider"] or "unknown",
                    "total_tokens": r["total_input_tokens"] + r["total_output_tokens"],
                    "sessions": r["sessions"],
                }
                for r in connection.execute(
                    """
                    SELECT
                        COALESCE(billing_provider, 'unknown') AS provider,
                        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                        COUNT(DISTINCT session_id) AS sessions
                    FROM session_model_usage
                    GROUP BY provider
                    ORDER BY (total_input_tokens + total_output_tokens) DESC
                    """
                ).fetchall()
            ]
        return [
            {
                "provider": r["provider"] or "unknown",
                "total_tokens": r["total_input_tokens"] + r["total_output_tokens"],
                "sessions": r["sessions"],
            }
            for r in connection.execute(
                """
                SELECT
                    COALESCE(billing_provider, 'unknown') AS provider,
                    COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                    COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                    COUNT(*) AS sessions
                FROM sessions
                GROUP BY provider
                ORDER BY (total_input_tokens + total_output_tokens) DESC
                """
            ).fetchall()
        ]

    def list_used_models(self, profile: str | None = None) -> list[str]:
        db_path = self.profiles.get_state_db_path(profile)
        if not db_path.exists():
            return []
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as connection:
            rows = connection.execute("SELECT DISTINCT model FROM sessions WHERE model IS NOT NULL ORDER BY model").fetchall()
        return [row[0] for row in rows]
