"""Gateway state query and lifecycle control."""
from __future__ import annotations

import json
import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from .cli_runner import find_command
from .profile_service import ProfileService
from .subprocess_utils import get_profile_env


@dataclass
class GatewayStatus:
    profile: str
    running: bool
    pid: int | None = None
    state: str | None = None
    platforms: dict = field(default_factory=dict)
    updated_at: str | None = None

    def to_dict(self) -> dict:
        return {
            "profile": self.profile,
            "running": self.running,
            "pid": self.pid,
            "state": self.state,
            "platforms": self.platforms,
            "updated_at": self.updated_at,
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
        try:
            env = get_profile_env(profile, self.hermes_home)
            result = subprocess.run(
                self._build_cmd(profile, action),
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
            )
        except subprocess.TimeoutExpired:
            return {"success": False, "message": f"{action} 超时"}
        except FileNotFoundError:
            return {"success": False, "message": "找不到 hermes 命令"}
        except Exception as exc:
            return {"success": False, "message": f"{action} 失败: {exc}"}

        if result.returncode == 0:
            return {"success": True, "message": f"Profile '{profile}' 的网关已{_PAST_TENSE[action]}"}
        return {"success": False, "message": f"{action} 失败: {result.stderr or result.stdout}"}


_PAST_TENSE = {
    "start": "启动",
    "stop": "停止",
    "restart": "重启",
}
