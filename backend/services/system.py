"""面板自身的数据采集、同步与审计服务。

包含：state.db 只读统计、profile 统计聚合、审计日志以及跨面板同步。
"""
from __future__ import annotations

import json
import logging
import secrets
import sqlite3
import string
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

import certifi
import urllib3

from backend.config import Settings, update_config_file
from backend.services.profile import ProfileService
from backend.store import (
    JsonStore,
    Profile,
    append_jsonl,
    next_id,
    read_jsonl,
)

logger = logging.getLogger(__name__)


# ── state.db 只读统计 ───────────────────────────────────────────────────────


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
            if not _table_exists(connection, "sessions"):
                logger.debug("aggregate_token_stats: no sessions table in %s, skip", db_path)
                return {
                    "total_input_tokens": 0,
                    "total_output_tokens": 0,
                    "total_cost_usd": 0.0,
                    "by_model": [],
                    "daily": [],
                }
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
            "model_daily": [],
        }
        if not db_path.exists():
            logger.debug("get_dashboard_data: state.db not found for profile=%s path=%s", profile, db_path)
            return empty

        logger.debug("get_dashboard_data: reading profile=%s db=%s", profile, db_path)

        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as connection:
            connection.row_factory = sqlite3.Row

            # 优先 session_model_usage（实时 per-request 记账，含进行中的 session）；
            # 没有该表的旧安装回退到 sessions 聚合。
            has_usage_table = _table_exists(connection, "session_model_usage")
            # state.db 可能根本不是 session 库（如被其它子系统复用），两表皆无时跳过统计而非抛异常。
            if not has_usage_table and not _table_exists(connection, "sessions"):
                logger.debug("get_dashboard_data: no session tables in %s, skip", db_path)
                return empty
            source_table = "session_model_usage" if has_usage_table else "sessions"
            logger.debug("get_dashboard_data: profile=%s using source=%s", profile, source_table)

            summary = self._read_summary(connection, has_usage_table)
            daily = self._read_daily(connection, has_usage_table)
            by_model = self._read_by_model(connection, has_usage_table)
            by_provider = self._read_by_provider(connection, has_usage_table)
            model_daily = self._read_model_daily(connection, has_usage_table)

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
            "model_daily": model_daily,
        }

    def _read_summary(self, connection: sqlite3.Connection, has_usage_table: bool) -> dict:
        """从合适的源表读取汇总统计。"""
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
        """从合适的源表读取每日 token 用量（含会话数与缓存读取，供时间范围聚合）。"""
        if has_usage_table:
            return [
                dict(r)
                for r in connection.execute(
                    """
                    SELECT
                        date(last_seen, 'unixepoch') AS day,
                        COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
                        COALESCE(SUM(input_tokens), 0) AS input_tokens,
                        COALESCE(SUM(output_tokens), 0) AS output_tokens,
                        COUNT(DISTINCT session_id) AS session_count,
                        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
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
                    COALESCE(SUM(output_tokens), 0) AS output_tokens,
                    COUNT(*) AS session_count,
                    COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
                FROM sessions
                GROUP BY day
                ORDER BY day
                """
            ).fetchall()
        ]

    def _read_model_daily(self, connection: sqlite3.Connection, has_usage_table: bool) -> list[dict]:
        """从合适的源表读取每日模型级 token 用量（供时间范围内模型 Top5）。"""
        if has_usage_table:
            rows = connection.execute(
                """
                SELECT
                    date(last_seen, 'unixepoch') AS day,
                    model,
                    COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
                FROM session_model_usage
                WHERE last_seen IS NOT NULL
                GROUP BY day, model
                ORDER BY day
                """
            ).fetchall()
        else:
            rows = connection.execute(
                """
                SELECT
                    date(started_at, 'unixepoch') AS day,
                    model,
                    COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
                FROM sessions
                GROUP BY day, model
                ORDER BY day
                """
            ).fetchall()
        return [
            {"day": r["day"], "model": r["model"] or "unknown", "total_tokens": r["total_tokens"] or 0}
            for r in rows
        ]

    def _read_by_model(self, connection: sqlite3.Connection, has_usage_table: bool) -> list[dict]:
        """从合适的源表读取模型级分解。"""
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
        """从合适的源表读取 provider 级分解。"""
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


# ── Profile 统计聚合 ────────────────────────────────────────────────────────

_DAILY_DAYS = 90
_MODEL_DAILY_DAYS = 30
_STALE_RECORD_SECONDS = 24 * 60 * 60
_TOP_N = 5

_RANGES = {"7d": 7, "30d": 30, "all": None}

_PROFILE_KEY_FIELDS = ("profile_name",)


def _default_profile() -> dict:
    return {
        "profile_name": "",
        "path": None,
        "session_count": 0,
        "total_tokens": 0,
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "cache_hit_rate": 0.0,
        "model_top5": [],
        "provider_top5": [],
        "daily_tokens": [],
        "model_daily": [],
        "updated_at": 0.0,
        "source": "local",
        "panel_name": None,
    }


def _profile_key(rec: dict) -> tuple:
    return tuple(rec.get(field) for field in _PROFILE_KEY_FIELDS)


def upsert_profile(items: list[dict], rec: dict) -> None:
    """插入或更新一条 profile 记录（原地修改 *items*）。"""
    key = _profile_key(rec)
    for item in items:
        if _profile_key(item) == key:
            for field, value in rec.items():
                if field != "id":
                    item[field] = value
            return
    new = _default_profile()
    new.update(rec)
    new["id"] = next_id(items)
    items.append(new)


def _dict_to_profile(d: dict) -> Profile:
    return Profile(
        id=int(d.get("id", 0)),
        profile_name=d.get("profile_name", ""),
        path=d.get("path"),
        session_count=int(d.get("session_count", 0)),
        total_tokens=int(d.get("total_tokens", 0)),
        total_input_tokens=int(d.get("total_input_tokens", 0)),
        total_output_tokens=int(d.get("total_output_tokens", 0)),
        cache_hit_rate=float(d.get("cache_hit_rate", 0.0)),
        model_top5=list(d.get("model_top5") or []),
        provider_top5=list(d.get("provider_top5") or []),
        daily_tokens=list(d.get("daily_tokens") or []),
        model_daily=list(d.get("model_daily") or []),
        updated_at=float(d.get("updated_at", 0)),
        source=d.get("source", "local"),
        panel_name=d.get("panel_name"),
    )


class ProfileStatsService:
    """采集与查询 profile 统计。"""

    _collect_lock = threading.Lock()

    def __init__(self, settings: Settings):
        self.settings = settings
        self.store = JsonStore(settings.data_dir)
        self.hermes_home = settings.hermes_home

    def collect_local_stats(self) -> None:
        """全量采集（每小时）；类级锁阻止后台循环与同步 API 请求并发。"""
        if not ProfileStatsService._collect_lock.acquire(blocking=False):
            logger.info("collect_local_stats: another collection is already running, skipping")
            return
        try:
            self._collect_impl(full=True)
        finally:
            ProfileStatsService._collect_lock.release()

    def collect_fast_stats(self) -> None:
        """快速采集（每 10 分钟）：仅 token 数据。"""
        if not ProfileStatsService._collect_lock.acquire(blocking=False):
            logger.info("collect_fast_stats: another collection is already running, skipping")
            return
        try:
            self._collect_impl(full=False)
        finally:
            ProfileStatsService._collect_lock.release()

    def _collect_impl(self, full: bool) -> None:
        """真正采集逻辑（在锁内调用）。"""
        profile_svc = ProfileService(self.hermes_home)
        state_reader = StateReader(self.hermes_home)
        profiles = profile_svc.list_profiles()
        now = time.time()
        collected = 0
        mode = "full" if full else "fast"

        logger.info(
            "collect_local_stats(%s): start scan profiles=%d",
            mode, len(profiles),
        )

        upserts: list[dict] = []
        for profile in profiles:
            info = profile_svc.get_profile_info(profile)
            if not info.exists:
                logger.debug("collect_local_stats(%s): skip non-existent profile=%s", mode, profile)
                continue

            token_data = state_reader.get_dashboard_data(profile)
            summary = token_data.get("summary", {})

            total_tokens = int(summary.get("total_tokens", 0))
            rec = {
                "profile_name": profile,
                "session_count": int(summary.get("total_sessions", 0)),
                "total_tokens": total_tokens,
                "total_input_tokens": int(summary.get("total_input_tokens", 0)),
                "total_output_tokens": int(summary.get("total_output_tokens", 0)),
                "cache_hit_rate": float(summary.get("cache_hit_rate", 0.0)),
                "updated_at": now,
                "source": "local",
                "panel_name": None,
            }

            if full:
                daily = token_data.get("daily", [])
                model_daily = token_data.get("model_daily", [])
                rec["path"] = str(profile_svc.profile_root(profile))
                rec["model_top5"] = self._top_n_by_tokens(token_data.get("by_model", []))
                rec["provider_top5"] = self._top_n_by_tokens(token_data.get("by_provider", []))
                rec["daily_tokens"] = daily[-_DAILY_DAYS:] if len(daily) > _DAILY_DAYS else daily
                rec["model_daily"] = model_daily[-_MODEL_DAILY_DAYS:] if len(model_daily) > _MODEL_DAILY_DAYS else model_daily

            upserts.append(rec)
            collected += 1
            logger.info(
                "collect_local_stats(%s): upserted profile=%s tokens=%d sessions=%s",
                mode,
                profile,
                total_tokens,
                summary.get("total_sessions", 0),
            )

        self.store.local_profiles.mutate(
            lambda items: [upsert_profile(items, rec) for rec in upserts]
        )

        logger.info(
            "collect_local_stats(%s): done collected=%d/%d elapsed=%.2fs",
            mode, collected, len(profiles), round(time.time() - now, 2),
        )

    def _read_local_records(self) -> list[dict]:
        """读取本机 profile 记录并补全来源标记。"""
        items: list[dict] = []
        for item in self.store.local_profiles.read():
            item = dict(item)
            item.setdefault("source", "local")
            item["panel_name"] = None
            items.append(item)
        return items

    def _read_remote_records(self) -> list[dict]:
        """读取所有远程面板的 profile 记录并补全来源标记。"""
        items: list[dict] = []
        for safe_name, records in self.store.iter_remote_profiles():
            for record in records:
                record = dict(record)
                record["source"] = "remote"
                record["panel_name"] = record.get("panel_name") or safe_name
                items.append(record)
        return items

    def _sorted_records(self, accessible_profiles: list[str] | None = None) -> list[dict]:
        """返回按 name/panel 排序的原始记录（本机 + 远程），可选用 profile 名过滤。"""
        items = self._read_local_records() + self._read_remote_records()
        if accessible_profiles is not None:
            allowed = set(accessible_profiles)
            items = [item for item in items if item.get("profile_name") in allowed]
        items.sort(key=lambda item: (item.get("profile_name") or "", item.get("panel_name") or ""))
        return items

    def cleanup_stale_records(self, now: float | None = None) -> int:
        """删除 24 小时未更新的 profile 记录（本机与各远程面板）。"""
        cutoff = (now if now is not None else time.time()) - _STALE_RECORD_SECONDS
        deleted = 0

        local_profiles = self.store.local_profiles.read()
        kept_local = [p for p in local_profiles if float(p.get("updated_at", 0)) >= cutoff]
        deleted += len(local_profiles) - len(kept_local)
        self.store.local_profiles.write(kept_local)

        for safe_name, records in self.store.iter_remote_profiles():
            kept = [p for p in records if float(p.get("updated_at", 0)) >= cutoff]
            deleted += len(records) - len(kept)
            self.store.remote_profiles(safe_name).write(kept)

        if deleted:
            logger.info("cleanup_stale_records: deleted=%d cutoff=%.0f", deleted, cutoff)
        return deleted

    def get_aggregated(
        self,
        accessible_profiles: list[str] | None = None,
        range: str = "all",
    ) -> dict:
        """返回所有 profile 的统计列表，可按时间范围聚合（7d/30d/all）。"""
        self.cleanup_stale_records()
        days = _RANGES.get(range)
        profiles = [
            _dict_to_profile(self._apply_range(item, days)).to_dict()
            for item in self._sorted_records(accessible_profiles)
        ]
        return {"profiles": profiles}

    @staticmethod
    def _apply_range(item: dict, days: int | None) -> dict:
        """把单条 profile 记录按 `days` 时间范围重新聚合；None 表示全部。"""
        if days is None:
            return item

        cutoff = (date.today() - timedelta(days=days - 1)).isoformat()
        daily = [d for d in item.get("daily_tokens", []) if (d.get("day") or "") >= cutoff]

        session_count = sum(int(d.get("session_count") or 0) for d in daily)
        total_tokens = sum(int(d.get("total_tokens") or 0) for d in daily)
        input_tokens = sum(int(d.get("input_tokens") or 0) for d in daily)
        output_tokens = sum(int(d.get("output_tokens") or 0) for d in daily)
        cache_read = sum(int(d.get("cache_read_tokens") or 0) for d in daily)
        total_input_all = input_tokens + cache_read
        cache_hit_rate = round(cache_read / total_input_all * 100, 1) if total_input_all > 0 else 0.0

        model_usage: dict[str, int] = {}
        for m in item.get("model_daily", []):
            if (m.get("day") or "") < cutoff:
                continue
            model = m.get("model") or "unknown"
            model_usage[model] = model_usage.get(model, 0) + int(m.get("total_tokens") or 0)
        model_top5 = [
            {"model": name, "total_tokens": tokens, "sessions": 0}
            for name, tokens in sorted(model_usage.items(), key=lambda kv: kv[1], reverse=True)[:_TOP_N]
        ]

        result = dict(item)
        result.update({
            "session_count": session_count,
            "total_tokens": total_tokens,
            "total_input_tokens": input_tokens,
            "total_output_tokens": output_tokens,
            "cache_hit_rate": cache_hit_rate,
            "model_top5": model_top5,
            "daily_tokens": daily,
        })
        return result

    @staticmethod
    def _top_n_by_tokens(items: list[dict]) -> list[dict]:
        sorted_items = sorted(
            items,
            key=lambda x: x.get("total_tokens", 0),
            reverse=True,
        )
        return sorted_items[:_TOP_N]


# ── 审计日志 ────────────────────────────────────────────────────────────────


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
    """持久化一条审计日志并返回其 id。"""
    record = {
        "id": time.time_ns(),
        "timestamp": time.time(),
        "actor": actor,
        "action": action,
        "target_type": target_type,
        "target_id": target_id,
        "details": details or {},
        "success": success,
        "ip_address": ip_address,
    }
    append_jsonl(JsonStore(settings.data_dir).audit_log, record)
    return record["id"]


def get_audit_logs(
    settings: Settings,
    *,
    limit: int = 100,
    offset: int = 0,
    action: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
) -> list[AuditLog]:
    """返回最近的审计日志，最新在前。"""
    records = read_jsonl(JsonStore(settings.data_dir).audit_log)

    def _match(record: dict) -> bool:
        if action and record.get("action") != action:
            return False
        if target_type and record.get("target_type") != target_type:
            return False
        if target_id and record.get("target_id") != target_id:
            return False
        return True

    logs = [_dict_to_log(r) for r in records if _match(r)]
    logs.sort(key=lambda item: item.timestamp, reverse=True)
    return logs[offset : offset + limit]


def _dict_to_log(record: dict) -> AuditLog:
    return AuditLog(
        id=int(record["id"]),
        timestamp=float(record["timestamp"]),
        actor=record.get("actor", ""),
        action=record.get("action", ""),
        target_type=record.get("target_type"),
        target_id=record.get("target_id"),
        details=record.get("details") or {},
        success=record.get("success"),
        ip_address=record.get("ip_address"),
    )


# ── 跨面板同步 ──────────────────────────────────────────────────────────────

# 接收同步的进程内状态。接收同步实现为 POST /sync/ 端点，无独立进程；
# 此处仅跟踪启用时间与最近接收 payload，供 UI 显示 "进程" 状态。
_receive_state: dict = {
    "enabled_at": None,
    "last_received_at": None,
    "last_profiles_count": 0,
    "total_payloads": 0,
    # panel_name -> {last_received_at, last_profiles_count, total_payloads}
    "panels": {},
}

# 发送同步的进程内状态。发送同步不是独立进程或心跳：主进程周期性循环，
# 启用时按间隔推送一次并记录结果。
_send_state: dict = {
    "enabled": False,
    "last_push_at": None,
    "last_push_ok": None,
    "last_push_message": None,
    "total_pushes": 0,
    "total_successes": 0,
    "total_failures": 0,
    "endpoints": {},
}


def set_receive_enabled(enabled: bool) -> None:
    """切换接收同步时更新运行时状态。"""
    if enabled and _receive_state["enabled_at"] is None:
        _receive_state["enabled_at"] = time.time()
        logger.info("Receive sync enabled - now accepting incoming sync payloads")
    elif not enabled and _receive_state["enabled_at"] is not None:
        _receive_state["enabled_at"] = None
        logger.info("Receive sync disabled - no longer accepting incoming sync payloads")


def set_send_enabled(enabled: bool) -> None:
    """切换发送同步时更新运行时状态。"""
    if enabled and not _send_state["enabled"]:
        _send_state["enabled"] = True
        logger.info("Send sync enabled - now pushing local stats to target panel")
    elif not enabled and _send_state["enabled"]:
        _send_state["enabled"] = False
        logger.info("Send sync disabled - no longer pushing to target panel")


def initialize_receive_state_from_settings(settings: Settings) -> None:
    """启动时从持久化设置恢复接收同步运行时状态。"""
    if settings.sync_receive_enabled and _receive_state["enabled_at"] is None:
        _receive_state["enabled_at"] = time.time()
        logger.info("Receive sync restored from settings - now accepting incoming sync payloads")


def initialize_send_state_from_settings(settings: Settings) -> None:
    """启动时从持久化设置恢复发送同步运行时状态。"""
    if settings.sync_enabled and not _send_state["enabled"]:
        _send_state["enabled"] = True
        logger.info("Send sync restored from settings - now pushing to target panel")


def record_push_result(endpoint: str, ok: bool, message: str | None = None) -> None:
    """记录某个端点的同步推送结果。"""
    _send_state["last_push_at"] = time.time()
    _send_state["last_push_ok"] = ok
    _send_state["last_push_message"] = message
    _send_state["total_pushes"] += 1
    if ok:
        _send_state["total_successes"] += 1
    else:
        _send_state["total_failures"] += 1

    ep = _send_state["endpoints"].setdefault(
        endpoint,
        {
            "last_push_at": None,
            "last_push_ok": None,
            "last_push_message": None,
            "total_pushes": 0,
            "total_successes": 0,
            "total_failures": 0,
        },
    )
    ep["last_push_at"] = time.time()
    ep["last_push_ok"] = ok
    ep["last_push_message"] = message
    ep["total_pushes"] += 1
    if ok:
        ep["total_successes"] += 1
    else:
        ep["total_failures"] += 1


def ensure_receive_token(settings: Settings) -> str:
    """返回配置的接收 token；未配置时生成随机 16 位 token 并持久化。"""
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
    """返回当前接收同步运行时状态，含按面板细分。"""
    enabled_at = _receive_state["enabled_at"]
    return {
        "enabled": enabled_at is not None,
        "enabled_at": enabled_at,
        "uptime_seconds": round(time.time() - enabled_at, 1) if enabled_at else 0,
        "last_received_at": _receive_state["last_received_at"],
        "last_profiles_count": _receive_state["last_profiles_count"],
        "total_payloads": _receive_state["total_payloads"],
        "panels": dict(_receive_state["panels"]),
    }


def get_send_status() -> dict:
    """返回当前发送同步运行时状态，含各端点统计。"""
    return {
        "enabled": _send_state["enabled"],
        "last_push_at": _send_state["last_push_at"],
        "last_push_ok": _send_state["last_push_ok"],
        "last_push_message": _send_state["last_push_message"],
        "total_pushes": _send_state["total_pushes"],
        "total_successes": _send_state["total_successes"],
        "total_failures": _send_state["total_failures"],
        "endpoints": dict(_send_state["endpoints"]),
    }


class SyncService:
    """把本地统计推送到其它面板，或接收其它面板的统计。"""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.store = JsonStore(settings.data_dir)
        self._http = urllib3.PoolManager(
            cert_reqs="CERT_REQUIRED",
            ca_certs=certifi.where(),
            timeout=urllib3.Timeout(connect=5, read=30),
        )

    def _target_url(self) -> str:
        """返回配置的同步端点，兼容旧版 base URL。"""
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
        if self.settings.panel_name:
            headers["X-Panel-Name"] = self.settings.panel_name
        token = token if token is not None else self.settings.sync_send_token
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def push(self, endpoint: str | None = None) -> dict:
        """采集本地统计并 POST 到目标面板。"""
        endpoints = self._send_endpoints()
        if not self.settings.sync_enabled or not endpoints:
            return {"ok": False, "message": "sync not configured"}

        payload = self._collect_payload()
        results = []
        for item in endpoints:
            if item.get("enabled", True) is False:
                continue
            target = item.get("endpoint") or item.get("url")
            if not target:
                continue
            if endpoint and target != endpoint:
                continue
            url = self._normalize_target_url(str(target))
            token = item.get("token")
            logger.info("Sync push starting: url=%s profiles=%d", url, len(payload.get("profiles", [])))
            try:
                response = self._http.request("POST", url, body=json.dumps(payload).encode("utf-8"), headers=self._headers(token))
                status = response.status
                message = response.data.decode("utf-8", errors="ignore")[:500]
                ok = status == 200
            except Exception:
                logger.exception("Sync push to %s failed", url)
                status = None
                message = "network error"
                ok = False
            record_push_result(str(target), ok, message)
            results.append({"endpoint": url, "ok": ok, "status": status, "message": message})
        if not results and endpoint:
            return {"ok": False, "message": "指定的端点未找到或已禁用"}
        ok = bool(results) and all(item["ok"] for item in results)
        return {"ok": ok, "results": results, "message": None if ok else "one or more sync endpoints failed"}

    def _normalize_target_url(self, target: str) -> str:
        target = target.rstrip("/")
        return f"{target}/" if target.endswith("/api/v1/sync") else f"{target}/api/v1/sync/"

    def _collect_payload(self) -> dict:
        """收集本面板要分享的**本机** profile 数据。"""
        stats_service = ProfileStatsService(self.settings)

        stats_service.cleanup_stale_records()
        profiles = [_dict_to_profile(item) for item in stats_service._read_local_records()]

        return {
            "profiles": [s.to_dict() for s in profiles],
            "synced_at": time.time(),
        }

    def ingest(self, payload: dict, panel_name: str = "unknown") -> dict:
        """把接收到的同步 payload 存入该远程面板对应的 JSON 文件。"""
        if not self.settings.sync_receive_enabled:
            raise ValueError("sync receive is disabled on this panel")
        profiles = payload.get("profiles", [])

        profile_recs: list[dict] = []
        for p in profiles:
            profile_recs.append(
                {
                    "profile_name": p.get("profile_name", ""),
                    # 远程 profile 携带的 path 是来源机器路径，在本机无意义，置空。
                    "path": None,
                    "session_count": int(p.get("session_count", 0)),
                    "total_tokens": int(p.get("total_tokens", 0)),
                    "total_input_tokens": int(p.get("total_input_tokens", 0)),
                    "total_output_tokens": int(p.get("total_output_tokens", 0)),
                    "cache_hit_rate": float(p.get("cache_hit_rate", 0.0)),
                    "model_top5": p.get("model_top5", []),
                    "provider_top5": p.get("provider_top5", []),
                    "daily_tokens": p.get("daily_tokens", []),
                    "model_daily": p.get("model_daily", []),
                    "updated_at": p.get("updated_at", time.time()),
                    "source": "remote",
                    "panel_name": panel_name,
                }
            )

        self.store.remote_profiles(panel_name).mutate(
            lambda items: [upsert_profile(items, rec) for rec in profile_recs]
        )

        now = time.time()
        _receive_state["last_received_at"] = now
        _receive_state["last_profiles_count"] = len(profiles)
        _receive_state["total_payloads"] += 1

        panel_state = _receive_state["panels"].setdefault(
            panel_name,
            {"last_received_at": None, "last_profiles_count": 0, "total_payloads": 0},
        )
        panel_state["last_received_at"] = now
        panel_state["last_profiles_count"] = len(profiles)
        panel_state["total_payloads"] += 1

        logger.info(
            "Sync payload received: panel=%s profiles=%d total_payloads=%d",
            panel_name,
            len(profiles),
            _receive_state["total_payloads"],
        )

        return {"ok": True, "profiles": len(profiles)}