from __future__ import annotations

import time
from pathlib import Path

import psutil

from backend.db.database import connect


class SystemMonitor:
    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)
        self._last_net = None

    def current_stats(self) -> dict:
        cpu = psutil.cpu_percent(interval=0.05)
        memory = psutil.virtual_memory()
        disk = psutil.disk_usage("/")
        net = psutil.net_io_counters()
        sent_rate = recv_rate = 0
        if self._last_net is not None:
            sent_rate = net.bytes_sent - self._last_net.bytes_sent
            recv_rate = net.bytes_recv - self._last_net.bytes_recv
        self._last_net = net
        load_avg = psutil.getloadavg() if hasattr(psutil, "getloadavg") else (0, 0, 0)

        stats = {
            "timestamp": time.time(),
            "cpu_percent": cpu,
            "cpu_count": psutil.cpu_count(),
            "memory": {
                "total_gb": round(memory.total / 1024**3, 2),
                "used_gb": round(memory.used / 1024**3, 2),
                "percent": memory.percent,
            },
            "disk": {
                "total_gb": round(disk.total / 1024**3, 2),
                "used_gb": round(disk.used / 1024**3, 2),
                "percent": disk.percent,
            },
            "network": {
                "bytes_sent_total": net.bytes_sent,
                "bytes_recv_total": net.bytes_recv,
                "bytes_sent_rate": sent_rate,
                "bytes_recv_rate": recv_rate,
            },
            "uptime_seconds": int(time.time() - psutil.boot_time()),
            "load_avg": load_avg,
        }
        self.record(stats)
        return stats

    def record(self, stats: dict) -> None:
        with connect(self.db_path) as connection:
            connection.execute(
                """
                INSERT INTO system_metrics (
                    timestamp, cpu_percent, memory_percent, memory_used_gb, memory_total_gb,
                    disk_percent, disk_used_gb, disk_total_gb, net_bytes_sent, net_bytes_recv, load_avg_1m
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    stats["timestamp"],
                    stats["cpu_percent"],
                    stats["memory"]["percent"],
                    stats["memory"]["used_gb"],
                    stats["memory"]["total_gb"],
                    stats["disk"]["percent"],
                    stats["disk"]["used_gb"],
                    stats["disk"]["total_gb"],
                    stats["network"]["bytes_sent_total"],
                    stats["network"]["bytes_recv_total"],
                    stats["load_avg"][0],
                ),
            )

    def history(self, minutes: int = 60) -> list[dict]:
        cutoff = time.time() - minutes * 60
        with connect(self.db_path) as connection:
            rows = connection.execute(
                """
                SELECT timestamp, cpu_percent, memory_percent, disk_percent, net_bytes_sent, net_bytes_recv, load_avg_1m
                FROM system_metrics
                WHERE timestamp >= ?
                ORDER BY timestamp ASC
                """,
                (cutoff,),
            ).fetchall()
        return [dict(row) for row in rows]