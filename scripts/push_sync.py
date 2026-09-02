#!/usr/bin/env python3
"""push_sync.py — 将本机 Hermes 数据推送到 hermes-panel 的接收端点。

独立运行能力：本脚本只依赖 Python 标准库（argparse / json / sqlite3 /
urllib），可复制到任意安装了 hermes 的机器上直接执行，无需安装任何第三方
包、也无需部署 hermes-panel。

它会把每个 profile 的 token 用量统计（来自 ~/.hermes 下各 profile 的
state.db）打包成与 hermes-panel 一致的 payload，POST 到接收端点的
/api/v1/sync/ 接口，使用接收 Token（Authorization: Bearer）完成鉴权。

用法示例:
    python3 push_sync.py --config ./push_sync.json
    python3 push_sync.py --url http://10.0.0.10:8650/api/v1/sync/ --token <TOKEN> --verbose
    # 推送预先准备好的 payload 文件（跳过本机采集）
    python3 push_sync.py --url http://10.0.0.10:8650/api/v1/sync/ --token <TOKEN> --payload ./payload.json

可用 --help 查看全部参数。
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

DEFAULT_PROFILE = "default"

DAILY_DAYS = 90
MODEL_DAILY_DAYS = 30


def discover_profiles(hermes_home: Path, selected: list[str] | None = None) -> list[str]:
    """扫描 hermes_home，返回全部 profile 名（含 default）。"""
    if selected:
        return list(dict.fromkeys(selected))
    profiles = [DEFAULT_PROFILE]
    profiles_dir = hermes_home / "profiles"
    if profiles_dir.is_dir():
        discovered = sorted(
            child.name
            for child in profiles_dir.iterdir()
            if child.is_dir() and (child / "config.yaml").exists()
        )
        profiles += discovered
    return profiles


def profile_root(hermes_home: Path, profile: str) -> Path:
    if profile == DEFAULT_PROFILE:
        return hermes_home
    return hermes_home / "profiles" / profile


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def read_profile_stats(hermes_home: Path, profile: str) -> dict:
    """读取单个 profile 的 state.db，返回与面板一致的统计字段。"""
    empty = {
        "session_count": 0,
        "total_tokens": 0,
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "cache_hit_rate": 0.0,
        "model_top5": [],
        "provider_top5": [],
        "daily_tokens": [],
        "model_daily": [],
    }
    db_path = profile_root(hermes_home, profile) / "state.db"
    if not db_path.exists():
        return empty

    try:
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
            conn.row_factory = sqlite3.Row
            has_usage = _table_exists(conn, "session_model_usage")
            table = "session_model_usage" if has_usage else "sessions"
            sessions_expr = "COUNT(DISTINCT session_id)" if has_usage else "COUNT(*)"

            # 汇总（与面板 _read_summary 的会话数口径一致）
            try:
                summary = dict(conn.execute(
                    f"""
                    SELECT
                        {sessions_expr} AS total_sessions,
                        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                        COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
                        COALESCE(SUM(cache_write_tokens), 0) AS total_cache_write,
                        COALESCE(SUM(estimated_cost_usd), 0) AS total_cost
                    FROM {table}
                    """
                ).fetchone())
            except sqlite3.Error:
                return empty

            total_input_all = summary["total_input_tokens"] + summary["total_cache_read"]
            summary["cache_hit_rate"] = round(
                summary["total_cache_read"] / total_input_all * 100, 1
            ) if total_input_all > 0 else 0.0

            # 按模型 Top5（会话数口径与面板 _read_by_model 一致）
            group_col = "model"
            count_expr = "COUNT(DISTINCT session_id)" if has_usage else "COUNT(*)"
            model_rows = conn.execute(
                f"""
                SELECT {group_col} AS model,
                       COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                       COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                       {count_expr} AS sessions
                FROM {table}
                GROUP BY {group_col}
                ORDER BY (total_input_tokens + total_output_tokens) DESC
                LIMIT 5
                """
            ).fetchall()
            model_top5 = [
                {
                    "model": r["model"] or "unknown",
                    "total_tokens": r["total_input_tokens"] + r["total_output_tokens"],
                    "sessions": r["sessions"],
                }
                for r in model_rows
            ]

            # 按 Provider Top5（session_model_usage 才有 billing_provider）
            provider_top5: list[dict] = []
            if has_usage:
                provider_rows = conn.execute(
                    """
                    SELECT COALESCE(billing_provider, 'unknown') AS provider,
                           COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                           COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                           COUNT(DISTINCT session_id) AS sessions
                    FROM session_model_usage
                    GROUP BY provider
                    ORDER BY (total_input_tokens + total_output_tokens) DESC
                    LIMIT 5
                    """
                ).fetchall()
                provider_top5 = [
                    {
                        "provider": r["provider"] or "unknown",
                        "total_tokens": r["total_input_tokens"] + r["total_output_tokens"],
                        "sessions": r["sessions"],
                    }
                    for r in provider_rows
                ]

            # 每日用量（含会话数与缓存读取，供面板时间范围聚合）
            day_col = "last_seen" if has_usage else "started_at"
            day_sessions_expr = "COUNT(DISTINCT session_id)" if has_usage else "COUNT(*)"
            daily_rows = conn.execute(
                f"""
                SELECT date({day_col}, 'unixepoch') AS day,
                       COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
                       COALESCE(SUM(input_tokens), 0) AS input_tokens,
                       COALESCE(SUM(output_tokens), 0) AS output_tokens,
                       {day_sessions_expr} AS session_count,
                       COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
                FROM {table}
                WHERE {day_col} IS NOT NULL
                GROUP BY day
                ORDER BY day
                """
            ).fetchall()
            daily_tokens = [
                {
                    "day": r["day"],
                    "total_tokens": r["total_tokens"],
                    "input_tokens": r["input_tokens"],
                    "output_tokens": r["output_tokens"],
                    "session_count": r["session_count"],
                    "cache_read_tokens": r["cache_read_tokens"],
                }
                for r in daily_rows
            ][-DAILY_DAYS:]

            # 每日模型级用量（供面板时间范围内模型 Top5）
            model_daily_rows = conn.execute(
                f"""
                SELECT date({day_col}, 'unixepoch') AS day,
                       model,
                       COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
                FROM {table}
                WHERE {day_col} IS NOT NULL
                GROUP BY day, model
                ORDER BY day
                """
            ).fetchall()
            model_daily = [
                {
                    "day": r["day"],
                    "model": r["model"] or "unknown",
                    "total_tokens": r["total_tokens"],
                }
                for r in model_daily_rows
            ][-MODEL_DAILY_DAYS:]
    except (sqlite3.Error, OSError):
        return empty

    return {
        "session_count": int(summary["total_sessions"]),
        "total_tokens": int(summary["total_input_tokens"] + summary["total_output_tokens"]),
        "total_input_tokens": int(summary["total_input_tokens"]),
        "total_output_tokens": int(summary["total_output_tokens"]),
        "cache_hit_rate": float(summary["cache_hit_rate"]),
        "model_top5": model_top5,
        "provider_top5": provider_top5,
        "daily_tokens": daily_tokens,
        "model_daily": model_daily,
    }


def build_payload(hermes_home: Path, profiles: list[str] | None = None) -> dict:
    """采集本机 profile 统计并组装与面板一致的 payload。"""
    collected: list[dict] = []
    for profile in discover_profiles(hermes_home, profiles):
        stats = read_profile_stats(hermes_home, profile)
        collected.append(
            {
                "profile_name": profile,
                "path": str(profile_root(hermes_home, profile)),
                **stats,
                "updated_at": time.time(),
            }
        )
    return {
        "profiles": collected,
        "synced_at": time.time(),
    }


def push_payload(url: str, token: str | None, payload: dict, timeout: int, panel_name: str | None = None) -> dict:
    """POST payload 到接收端点，返回 (ok, message)。"""
    headers = {"Content-Type": "application/json"}
    if panel_name:
        headers["X-Panel-Name"] = panel_name
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="ignore")
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                data = {"raw": raw}
            return {"ok": response.status == 200, "status": response.status, "data": data}
    except urllib.error.HTTPError as exc:
        message = exc.read().decode("utf-8", errors="ignore")[:500]
        return {"ok": False, "status": exc.code, "message": message}
    except Exception as exc:
        return {"ok": False, "status": None, "message": str(exc)}


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="push_sync.py",
        description="将本机 Hermes 数据推送到 hermes-panel 接收端点（/api/v1/sync/），独立运行，仅依赖 Python 标准库。",
    )
    parser.add_argument("--config", default=None, help="JSON 配置文件路径，命令行参数优先")
    parser.add_argument("--url", default=None, help="单个接收端点完整地址")
    parser.add_argument("--urls", default=None, help="多个接收端点，逗号分隔")
    parser.add_argument("--token", default=None, help="接收 Token（Authorization: Bearer）")
    parser.add_argument("--payload", default=None, help="推送预先准备好的 JSON payload 文件（跳过本机采集）")
    parser.add_argument("--hermes-home", default=None, help="Hermes 主目录（默认 ~/.hermes）")
    parser.add_argument("--profiles", default=None, help="只采集指定 Profile，逗号分隔；默认自动发现")
    parser.add_argument("--panel-name", default=None, help="本面板标识（发送 X-Panel-Name 头，接收端据此区分来源）")
    parser.add_argument("--timeout", type=int, default=30, help="HTTP 请求超时秒数（默认 30）")
    parser.add_argument("-v", "--verbose", action="store_true", help="打印采集到的 payload 摘要")
    args = parser.parse_args()

    config: dict = {}
    if args.config:
        try:
            with open(args.config, encoding="utf-8") as f:
                config = json.load(f)
            if not isinstance(config, dict):
                raise ValueError("配置文件必须是 JSON 对象")
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            print(f"[错误] 读取配置文件失败: {exc}", file=sys.stderr)
            return 2

    def value(name: str, default=None):
        return getattr(args, name) if getattr(args, name) is not None else config.get(name, default)

    url = value("url")
    urls = value("urls")
    if isinstance(urls, str):
        urls = [item.strip() for item in urls.split(",") if item.strip()]
    elif not urls:
        urls = [url] if url else []
    token = value("token")
    panel_name = value("panel_name")
    timeout = int(value("timeout", 30))
    hermes_home = Path(value("hermes_home", str(Path.home() / ".hermes"))).expanduser()
    profiles = value("profiles")
    profiles = [item.strip() for item in profiles.split(",") if item.strip()] if isinstance(profiles, str) else profiles

    if not urls:
        parser.error("必须提供 --url/--urls，或在 JSON 配置中设置 url/urls")

    if args.payload:
        try:
            with open(args.payload, encoding="utf-8") as f:
                payload = json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[错误] 读取 payload 文件失败: {exc}", file=sys.stderr)
            return 2
        if not isinstance(payload, dict):
            print("[错误] payload 文件必须是 JSON 对象", file=sys.stderr)
            return 2
        print(f"[信息] 使用已提供的 payload 文件: {args.payload}")
    else:
        if not hermes_home.is_dir():
            print(f"[错误] Hermes 主目录不存在: {hermes_home}", file=sys.stderr)
            return 2
        payload = build_payload(hermes_home, profiles=profiles)
        print(f"[信息] 已采集本机数据: profiles={len(payload['profiles'])}")

    if args.verbose:
        print(json.dumps(payload, ensure_ascii=False, indent=2))

    results = [push_payload(target, token, payload, timeout, panel_name) for target in urls]
    if all(result.get("ok") for result in results):
        print(f"[成功] {len(results)} 个端点均推送成功")
        return 0
    for target, result in zip(urls, results):
        if not result.get("ok"):
            print(f"[失败] {target}: {result.get('status')}: {result.get('message') or result.get('data') or 'unknown'}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())