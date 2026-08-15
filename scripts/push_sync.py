#!/usr/bin/env python3
"""push_sync.py — 将本机 Hermes 数据推送到 hermes-panel 的接收端点。

独立运行能力：本脚本只依赖 Python 标准库（argparse / json / sqlite3 /
subprocess / urllib / socket / pwd），可复制到任意安装了 hermes 的机器上
直接执行，无需安装任何第三方包、也无需部署 hermes-panel。

它会把本机的 host_info（主机名/用户/IP/组件版本）和每个 profile 的
token 用量统计（来自 ~/.hermes 下各 profile 的 state.db）打包成与
hermes-panel 一致的 payload，POST 到接收端点的 /api/v1/sync/ 接口，
使用接收 Token（Authorization: Bearer）完成鉴权。

用法示例:
    python3 push_sync.py --url http://10.0.0.10:8650/api/v1/sync/ --token <RECEIVE_TOKEN>
    python3 push_sync.py --url http://10.0.0.10:8650/api/v1/sync/ --token <TOKEN> --verbose
    # 推送预先准备好的 payload 文件（跳过本机采集）
    python3 push_sync.py --url http://10.0.0.10:8650/api/v1/sync/ --token <TOKEN> --payload ./payload.json

可用 --help 查看全部参数。
"""
from __future__ import annotations

import argparse
import json
import os
import pwd
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from pathlib import Path

DEFAULT_PROFILE = "default"

# 与面板 config.yaml 的 component_versions 保持一致；本机缺失的命令自动跳过。
COMPONENTS: list[tuple[str, list[str]]] = [
    ("hermes", ["--version"]),
    ("node", ["--version"]),
    ("npm", ["--version"]),
    ("git", ["--version"]),
    ("lark-cli", ["--version"]),
    ("quectel-cli", ["--version"]),
]

DAILY_DAYS = 15


def get_username() -> str:
    """返回当前 Linux 用户名。"""
    try:
        return pwd.getpwuid(os.getuid()).pw_name
    except Exception:
        return os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"


def get_primary_ip() -> str:
    """返回本机主网卡（非回环）IPv4 地址。"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


def run_cmd(cmd: list[str], timeout: int = 5) -> str | None:
    """执行命令并返回首行非空输出；失败或超时返回 None。"""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError):
        return None
    output = (result.stdout or result.stderr).strip()
    for line in output.splitlines():
        line = line.strip()
        if line:
            return line
    return None


def discover_profiles(hermes_home: Path) -> list[str]:
    """扫描 hermes_home，返回全部 profile 名（含 default）。"""
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
        "gateway_status": None,
        "session_count": 0,
        "total_tokens": 0,
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "cache_hit_rate": 0.0,
        "model_top5": [],
        "provider_top5": [],
        "daily_tokens": [],
    }
    db_path = profile_root(hermes_home, profile) / "state.db"
    if not db_path.exists():
        return empty

    try:
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
            conn.row_factory = sqlite3.Row
            has_usage = _table_exists(conn, "session_model_usage")
            table = "session_model_usage" if has_usage else "sessions"
            session_col = "session_id" if has_usage else "id"

            # 汇总
            try:
                summary = dict(conn.execute(
                    f"""
                    SELECT
                        COUNT({session_col}) AS total_sessions,
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

            # 按模型 Top5
            group_col = "model"
            count_expr = f"COUNT({session_col})" if has_usage else "COUNT(*)"
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

            # 每日用量（最近 15 天）
            day_col = "last_seen" if has_usage else "started_at"
            daily_rows = conn.execute(
                f"""
                SELECT date({day_col}, 'unixepoch') AS day,
                       COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
                       COALESCE(SUM(input_tokens), 0) AS input_tokens,
                       COALESCE(SUM(output_tokens), 0) AS output_tokens
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
                }
                for r in daily_rows
            ][-DAILY_DAYS:]
    except (sqlite3.Error, OSError):
        return empty

    return {
        "gateway_status": None,
        "session_count": int(summary["total_sessions"]),
        "total_tokens": int(summary["total_input_tokens"] + summary["total_output_tokens"]),
        "total_input_tokens": int(summary["total_input_tokens"]),
        "total_output_tokens": int(summary["total_output_tokens"]),
        "cache_hit_rate": float(summary["cache_hit_rate"]),
        "model_top5": model_top5,
        "provider_top5": provider_top5,
        "daily_tokens": daily_tokens,
    }


def collect_host_info(hermes_home: Path, collect_components: bool) -> dict:
    """采集本机 host_info。"""
    host = socket.gethostname()
    username = get_username()
    ip = get_primary_ip()
    hermes_version = None
    components: dict[str, str] = {}
    if collect_components:
        for name, args in COMPONENTS:
            version = run_cmd([name] + args, timeout=3)
            if version:
                components[name] = version
        hermes_version = components.get("hermes")
    return {
        "host": host,
        "username": username,
        "ip": ip,
        "hermes_version": hermes_version,
        "components": components,
        "system_versions": components,
        "updated_at": time.time(),
    }


def build_payload(hermes_home: Path, collect_components: bool) -> dict:
    """采集本机数据并组装与面板一致的 payload。"""
    host_info = collect_host_info(hermes_home, collect_components)
    server_id = f"{host_info['host']}|{host_info['username']}|{host_info['ip']}"
    profiles: list[dict] = []
    for profile in discover_profiles(hermes_home):
        stats = read_profile_stats(hermes_home, profile)
        profiles.append(
            {
                "host": host_info["host"],
                "username": host_info["username"],
                "ip": host_info["ip"],
                "server_id": server_id,
                "profile_name": profile,
                "path": str(profile_root(hermes_home, profile)),
                **stats,
                "updated_at": time.time(),
            }
        )
    return {
        "server_id": server_id,
        "profiles": profiles,
        "hosts": [host_info],
        "synced_at": time.time(),
    }


def push_payload(url: str, token: str | None, payload: dict, timeout: int) -> dict:
    """POST payload 到接收端点，返回 (ok, message)。"""
    headers = {"Content-Type": "application/json"}
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
    parser.add_argument("--url", required=True, help="接收端点完整地址，例如 http://10.0.0.10:8650/api/v1/sync/")
    parser.add_argument("--token", default=None, help="接收 Token（Authorization: Bearer），与接收端配置的 receive_token 一致")
    parser.add_argument("--payload", default=None, help="推送预先准备好的 JSON payload 文件（跳过本机采集）")
    parser.add_argument("--hermes-home", default=str(Path.home() / ".hermes"), help="Hermes 主目录（默认 ~/.hermes）")
    parser.add_argument("--no-components", action="store_true", help="跳过组件版本采集（hermes/node/npm/git 等）")
    parser.add_argument("--timeout", type=int, default=30, help="HTTP 请求超时秒数（默认 30）")
    parser.add_argument("-v", "--verbose", action="store_true", help="打印采集到的 payload 摘要")
    args = parser.parse_args()

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
        hermes_home = Path(args.hermes_home).expanduser()
        if not hermes_home.is_dir():
            print(f"[错误] Hermes 主目录不存在: {hermes_home}", file=sys.stderr)
            return 2
        payload = build_payload(hermes_home, collect_components=not args.no_components)
        print(
            f"[信息] 已采集本机数据: profiles={len(payload['profiles'])} hosts={len(payload['hosts'])}"
        )

    if args.verbose:
        print(json.dumps(payload, ensure_ascii=False, indent=2))

    result = push_payload(args.url, args.token, payload, args.timeout)
    if result.get("ok"):
        print(f"[成功] 推送成功，状态码 {result.get('status')}")
        return 0
    print(
        f"[失败] 推送失败，状态码 {result.get('status')}: {result.get('message') or result.get('data') or 'unknown'}",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
