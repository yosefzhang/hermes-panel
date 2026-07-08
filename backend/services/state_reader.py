from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

from .profile_service import ProfileService


class StateReader:
    def __init__(self, hermes_home: str | Path | None = None):
        self.profiles = ProfileService(hermes_home)

    def aggregate_token_stats(self, profile: str | None = None, days: int = 30) -> dict:
        db_path = self.profiles.get_state_db_path(profile)
        if not db_path.exists():
            return {
                "total_input_tokens": 0,
                "total_output_tokens": 0,
                "total_cost_usd": 0.0,
                "by_model": [],
                "daily": [],
            }

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
            return empty

        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as connection:
            connection.row_factory = sqlite3.Row

            s = dict(
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
            total_tokens = s["total_input_tokens"] + s["total_output_tokens"]
            s["total_tokens"] = total_tokens
            s["total_cost_usd"] = round(s["total_cost"], 6)
            total_input_all = s["total_input_tokens"] + s["total_cache_read"]
            s["cache_hit_rate"] = round(s["total_cache_read"] / total_input_all * 100, 1) if total_input_all > 0 else 0.0

            daily = [
                dict(r)
                for r in connection.execute(
                    """
                    SELECT
                        date(started_at, 'unixepoch') AS day,
                        COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
                    FROM sessions
                    GROUP BY day
                    ORDER BY day
                    """
                ).fetchall()
            ]

            by_model = [
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

            by_provider = [
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

        return {
            "summary": s,
            "by_model": by_model,
            "by_provider": by_provider,
            "daily": daily,
        }

    def list_used_models(self, profile: str | None = None) -> list[str]:
        db_path = self.profiles.get_state_db_path(profile)
        if not db_path.exists():
            return []
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as connection:
            rows = connection.execute("SELECT DISTINCT model FROM sessions WHERE model IS NOT NULL ORDER BY model").fetchall()
        return [row[0] for row in rows]