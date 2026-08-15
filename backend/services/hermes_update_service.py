from __future__ import annotations

import logging
import re
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

from backend.services.cli_utils import find_command, get_clean_env


logger = logging.getLogger(__name__)

# 模块级升级状态（单例，全局唯一）
_upgrade_state: dict = {
    "running": False,
    "pid": None,
    "started_at": None,
    "finished_at": None,
    "success": None,
    "output": "",  # 最多保留最后 10000 字符
}

# `hermes update --check` 输出中的语义关键词
_UP_TO_DATE_PATTERNS = (
    r"up[\s-]?to[\s-]?date",
    r"already .*latest",
    r"no .*updates? available",
    r"已是最新",
    r"无可用更新",
)
_UPDATE_AVAILABLE_PATTERNS = (
    r"commits? behind",
    r"\bbehind\b",
    r"updates? available",
    r"new version",
    r"can be updated",
    r"有可用更新",
    r"可升级",
)


class HermesUpdateService:
    def __init__(self):
        self.hermes_bin = find_command("hermes")
        self.github_api_url = "https://api.github.com/repos/NousResearch/hermes-agent/releases/latest"
        self.current_version = self._get_current_version()

    def _get_current_version(self) -> str:
        """获取当前安装的 Hermes 版本。"""
        if not self.hermes_bin:
            return "unknown"
        try:
            full_cmd = [self.hermes_bin, "--version"]
            logger.info("_get_current_version: running cmd=%s", full_cmd)
            result = subprocess.run(
                full_cmd,
                capture_output=True,
                text=True,
                timeout=5,
                env=get_clean_env(),
            )
            logger.info("_get_current_version: cmd=%s rc=%d", full_cmd, result.returncode)
            if result.returncode == 0:
                # 例："Hermes Agent v0.18.0 (2026.7.1) · upstream ..."
                match = re.search(r"(\d+\.\d+\.\d+)", result.stdout)
                if match:
                    return f"v{match.group(1)}"
        except Exception:
            pass
        return "unknown"

    @staticmethod
    def _parse_version(version: str) -> tuple[int, ...]:
        """解析版本号为可比较的整数元组，兼容 semver 与日期版号。"""
        numbers = re.findall(r"\d+", version or "")
        return tuple(int(n) for n in numbers)

    @staticmethod
    def _extract_semver_from_name(name: str) -> str | None:
        """从 release name 中提取 semver 版本号，如 v0.18.0。"""
        match = re.search(r"v?(\d+\.\d+\.\d+)", name or "")
        return f"v{match.group(1)}" if match else None

    def _cli_check(self, timeout: int = 90) -> tuple[bool | None, str]:
        """运行 `hermes update --check`，返回 (是否有更新, 原始输出)。

        返回值第一项为 None 表示输出无法判定（网络失败、格式变化等），
        此时调用方应回退到基于版本号的比较。
        """
        if not self.hermes_bin:
            return None, ""
        try:
            full_cmd = [self.hermes_bin, "update", "--check"]
            logger.info("_cli_check: running cmd=%s", full_cmd)
            result = subprocess.run(
                full_cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=get_clean_env(),
            )
        except Exception as exc:  # noqa: BLE001 - 检查失败一律视为不可判定
            logger.error("_cli_check: cmd=%s failed: %s", full_cmd, exc)
            return None, f"update --check failed: {exc}"

        logger.info(
            "_cli_check: cmd=%s rc=%d stdout_len=%d stderr_len=%d",
            full_cmd, result.returncode, len(result.stdout), len(result.stderr),
        )
        output = f"{result.stdout}\n{result.stderr}".strip()
        lowered = output.lower()

        # fetch 失败等错误 -> 不可判定
        if "failed to fetch" in lowered or "fatal:" in lowered:
            return None, output

        for pattern in _UPDATE_AVAILABLE_PATTERNS:
            if re.search(pattern, lowered):
                return True, output
        for pattern in _UP_TO_DATE_PATTERNS:
            if re.search(pattern, lowered):
                return False, output
        return None, output

    def _fetch_github_release(self) -> dict | None:
        """拉取 GitHub 最新 release 作为展示增强信息。"""
        try:
            response = requests.get(
                self.github_api_url,
                headers={
                    "Accept": "application/vnd.github.v3+json",
                    "User-Agent": "Hermes-Panel",
                },
                timeout=10,
            )
        except requests.exceptions.RequestException:
            return None
        if response.status_code != 200:
            return None

        data = response.json()
        tag = data.get("tag_name", "")
        latest_version = self._extract_semver_from_name(data.get("name", "")) or (
            f"v{tag.lstrip('vV')}" if tag else None
        )
        return {
            "latest_version": latest_version,
            "latest_version_tag": tag,
            "release_notes": data.get("body", ""),
            "published_at": data.get("published_at", ""),
            "release_url": data.get("html_url", ""),
        }

    def _do_check_for_updates(self, cli_timeout: int = 90) -> dict:
        """实际执行检查并返回结果（不读缓存）。

        CLI 检查与 GitHub release 查询并行执行，整体耗时由两者中较慢的一方决定，
        避免串行等待导致前端超时取消请求。
        """
        if not self.hermes_bin:
            return {
                "current_version": self.current_version,
                "latest_version": None,
                "has_update": False,
                "error": "hermes CLI not found on PATH",
            }

        with ThreadPoolExecutor(max_workers=2) as executor:
            cli_future = executor.submit(self._cli_check, cli_timeout)
            github_future = executor.submit(self._fetch_github_release)
            cli_has_update, cli_output = cli_future.result()
            github = github_future.result()

        result: dict = {
            "current_version": self.current_version,
            "latest_version": None,
            "latest_version_tag": "",
            "release_notes": "",
            "published_at": "",
            "release_url": "",
            "check_output": cli_output,
        }
        if github:
            result.update(github)

        if cli_has_update is not None:
            result["has_update"] = cli_has_update
        elif github and github.get("latest_version"):
            # CLI 不可判定：回退到版本号比较
            result["has_update"] = (
                self._parse_version(github["latest_version"])
                > self._parse_version(self.current_version)
            )
        else:
            result["has_update"] = False

        return result

    def check_for_updates(self) -> dict:
        """检查是否有新版本可用。

        每次调用都同步执行一次检查；CLI 命令设置 15 秒超时，避免网络不可达时
        长时间挂起。由前端手动触发（点击刷新），后端不做自动轮询。
        """
        return self._do_check_for_updates(cli_timeout=15)

    def start_upgrade(self) -> dict:
        """启动 Hermes 升级（后台异步执行 `hermes update`）。"""
        global _upgrade_state

        if _upgrade_state["running"]:
            return {
                "success": False,
                "message": "升级已在进行中，请等待完成",
                "status": _upgrade_state,
            }
        if not self.hermes_bin:
            return {"success": False, "message": "未找到 hermes CLI"}

        _upgrade_state.update(
            running=True,
            pid=None,
            started_at=time.time(),
            finished_at=None,
            success=None,
            output="",
        )

        hermes_bin = self.hermes_bin

        def _run_upgrade():
            global _upgrade_state
            try:
                full_cmd = [hermes_bin, "update"]
                logger.info("_run_upgrade: running cmd=%s", full_cmd)
                proc = subprocess.Popen(
                    full_cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                    env=get_clean_env(),
                )
                _upgrade_state["pid"] = proc.pid
                if proc.stdout:
                    for line in proc.stdout:
                        _upgrade_state["output"] += line
                        if len(_upgrade_state["output"]) > 10000:
                            _upgrade_state["output"] = _upgrade_state["output"][-10000:]
                proc.wait()
                _upgrade_state["success"] = proc.returncode == 0
            except Exception as e:
                _upgrade_state["output"] += f"\n[ERROR] {e}\n"
                _upgrade_state["success"] = False
            finally:
                _upgrade_state["running"] = False
                _upgrade_state["finished_at"] = time.time()
                _upgrade_state["pid"] = None

        threading.Thread(target=_run_upgrade, daemon=True).start()
        return {"success": True, "message": "升级已启动，请耐心等待"}

    @staticmethod
    def get_upgrade_status() -> dict:
        """获取当前升级状态。"""
        return {
            "running": _upgrade_state["running"],
            "success": _upgrade_state["success"],
            "started_at": _upgrade_state["started_at"],
            "finished_at": _upgrade_state["finished_at"],
            "output": _upgrade_state["output"],
        }
