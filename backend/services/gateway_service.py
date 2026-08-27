"""Gateway state query and lifecycle control."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from .cli_utils import find_command, get_profile_env
from .profile_service import ProfileService


logger = logging.getLogger(__name__)

_PAST_TENSE = {
    "start": "启动",
    "stop": "停止",
    "restart": "重启",
}


@dataclass
class GatewayStatus:
    profile: str
    running: bool
    pid: int | None = None
    state: str | None = None
    platforms: dict = field(default_factory=dict)
    updated_at: str | None = None
    started_at: float | None = None

    def to_dict(self) -> dict:
        return {
            "profile": self.profile,
            "running": self.running,
            "pid": self.pid,
            "state": self.state,
            "platforms": self.platforms,
            "updated_at": self.updated_at,
            "started_at": self.started_at,
        }


class GatewayService:
    """Reads PID/state files and shells out to the CLI to control the gateway."""

    def __init__(self):
        self.profiles = ProfileService()
        self.hermes_home = self.profiles.hermes_home

    # ── file helpers ──────────────────────────────────────

    def _profile_home(self, profile: str) -> Path:
        if profile == "default":
            return self.hermes_home
        return self.hermes_home / "profiles" / profile

    def _pid_path(self, profile: str) -> Path:
        return self._profile_home(profile) / "gateway.pid"

    def _state_path(self, profile: str) -> Path:
        return self._profile_home(profile) / "gateway_state.json"

    def _read_pid(self, profile: str) -> int | None:
        pid_path = self._pid_path(profile)
        if not pid_path.exists():
            return None
        try:
            content = pid_path.read_text().strip()
        except OSError:
            return None
        if not content:
            return None
        try:
            data = json.loads(content)
        except json.JSONDecodeError:
            try:
                return int(content)
            except ValueError:
                return None
        if isinstance(data, dict):
            return int(data.get("pid", 0)) or None
        try:
            return int(data)
        except (TypeError, ValueError):
            return None

    def _read_state(self, profile: str) -> dict | None:
        state_path = self._state_path(profile)
        if not state_path.exists():
            return None
        try:
            return json.loads(state_path.read_text().strip())
        except (json.JSONDecodeError, OSError):
            return None

    @staticmethod
    def _is_process_running(pid: int) -> bool:
        if pid <= 0:
            return False
        try:
            os.kill(pid, 0)
            return True
        except (OSError, ProcessLookupError):
            return False

    @staticmethod
    def _process_start_ts(pid: int) -> float | None:
        """从 /proc/<pid>/stat 读取进程启动时刻（epoch 秒），失败时返回 None。

        第 22 个字段是启动时刻的 clock ticks，结合 /proc/stat 的 btime 换算。
        """
        try:
            stat = Path(f"/proc/{pid}/stat").read_text()
        except OSError:
            return None
        # comm 字段可能包含空格或括号，取最后一个 ')' 之后的部分，即字段 3 起
        body = stat.rsplit(")", 1)[1].split()
        if len(body) < 20:
            return None
        try:
            starttime = int(body[19])  # 字段 22 → body 下标 19
            clk_tck = os.sysconf("SC_CLK_TCK")
            btime = None
            for line in Path("/proc/stat").read_text().splitlines():
                if line.startswith("btime "):
                    btime = int(line.split()[1])
                    break
            if btime is None:
                return None
        except (ValueError, OSError, IndexError):
            return None
        return btime + starttime / clk_tck

    # ── public API ────────────────────────────────────────

    def get_status(self, profile: str) -> GatewayStatus:
        pid = self._read_pid(profile)
        running = pid is not None and self._is_process_running(pid)
        state_info = self._read_state(profile)
        state = None
        platforms: dict = {}
        updated_at = None
        if state_info:
            state = state_info.get("gateway_state")
            platforms = state_info.get("platforms", {}) or {}
            updated_at = state_info.get("updated_at")
            # PID truth wins over stale "running" in state file.
            if state == "running" and not running:
                state = "stopped"
        return GatewayStatus(
            profile=profile,
            running=running,
            pid=pid,
            state=state,
            platforms=platforms,
            updated_at=updated_at,
            started_at=self._process_start_ts(pid) if running and pid else None,
        )

    def get_statuses(self, profiles: list[str]) -> list[GatewayStatus]:
        return [self.get_status(profile) for profile in profiles]

    def start(self, profile: str) -> dict:
        status = self.get_status(profile)
        if status.running:
            return {
                "success": False,
                "message": f"Profile '{profile}' 的网关已经在运行 (PID: {status.pid})",
            }
        result = self._run(profile, "start", timeout=30)
        if result["success"]:
            time.sleep(2)
            result["status"] = self.get_status(profile).to_dict()
        return result

    def stop(self, profile: str) -> dict:
        status = self.get_status(profile)
        if not status.running:
            return {
                "success": False,
                "message": f"Profile '{profile}' 的网关未在运行",
            }
        result = self._run(profile, "stop", timeout=30)
        if result["success"]:
            time.sleep(1)
            result["status"] = self.get_status(profile).to_dict()
        return result

    def restart(self, profile: str) -> dict:
        status = self.get_status(profile)
        if not status.running:
            # 未运行时重启等价于启动；避免 `hermes gateway restart` 在无守护进程时长时间挂起
            return self.start(profile)
        result = self._run(profile, "restart", timeout=50)
        if result["success"]:
            time.sleep(2)
            result["status"] = self.get_status(profile).to_dict()
        return result

    # ── internals ─────────────────────────────────────────

    def _build_cmd(self, profile: str, action: str) -> list[str]:
        """Build a `gateway <action>` command for *profile*.
        
        Always uses `hermes -p <profile>` format for non-default profiles.
        Does NOT use profile-named shims.
        """
        hermes = find_command("hermes") or "hermes"
        if profile == "default":
            return [hermes, "gateway", action]
        return [hermes, "-p", profile, "gateway", action]

    def _run(self, profile: str, action: str, *, timeout: int) -> dict:
        full_cmd = self._build_cmd(profile, action)
        logger.info("gateway _run: running cmd=%s", full_cmd)
        try:
            env = get_profile_env(profile, self.hermes_home)
            result = subprocess.run(
                full_cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
            )
        except subprocess.TimeoutExpired:
            logger.error("gateway _run: cmd=%s timeout", full_cmd)
            return {"success": False, "message": f"{action} 超时"}
        except FileNotFoundError:
            logger.error("gateway _run: cmd=%s hermes not found", full_cmd)
            return {"success": False, "message": "找不到 hermes 命令"}
        except Exception as exc:
            logger.error("gateway _run: cmd=%s failed: %s", full_cmd, exc)
            return {"success": False, "message": f"{action} 失败: {exc}"}

        logger.info(
            "gateway _run: cmd=%s rc=%d stdout_len=%d stderr_len=%d",
            full_cmd, result.returncode, len(result.stdout), len(result.stderr),
        )
        if result.returncode == 0:
            return {"success": True, "message": f"Profile '{profile}' 的网关已{_PAST_TENSE[action]}"}
        logger.warning(
            "gateway _run: cmd=%s rc=%d stderr=%s",
            full_cmd, result.returncode, result.stderr[:500],
        )
        return {"success": False, "message": f"{action} 失败: {result.stderr or result.stdout}"}
