from __future__ import annotations

import os
import sqlite3
import subprocess
from pathlib import Path

from backend.db.models import User

from .cli_runner import EXTRA_BIN_PATHS, find_command
from .profile_service import ProfileService
from .subprocess_utils import get_clean_env


class HermesInfoService:
    def __init__(self, hermes_home: Path | None = None):
        self.profiles = ProfileService(hermes_home)
        self.hermes_home = self.profiles.hermes_home

    def format_size(self, size: int) -> str:
        """格式化文件大小"""
        for unit in ["B", "KB", "MB", "GB"]:
            if size < 1024:
                return f"{size:.1f} {unit}"
            size /= 1024
        return f"{size:.1f} TB"

    def find_command(self, command: str) -> str | None:
        """查找命令的完整路径（含 node/npm 常见安装目录）"""
        return find_command(command, extra_paths=EXTRA_BIN_PATHS)

    def get_command_version(self, command: str, args: list[str] = ["--version"]) -> str | None:
        """获取命令版本"""
        cmd_path = self.find_command(command)
        if not cmd_path:
            return None
        
        try:
            env = get_clean_env()
            
            node_path = self.find_command("node")
            if node_path:
                node_dir = os.path.dirname(node_path)
                env["PATH"] = f"{node_dir}:{env.get('PATH', '')}"
            
            result = subprocess.run(
                [cmd_path] + args,
                capture_output=True,
                text=True,
                timeout=5,
                env=env,
            )
            output = result.stdout.strip() or result.stderr.strip()
            # 提取版本号
            for line in output.split("\n"):
                line = line.strip()
                if line:
                    return line
            return output if output else None
        except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError):
            return None

    def get_db_stats(self, db_path: Path) -> dict | None:
        """获取数据库统计信息"""
        if not db_path.exists():
            return None
        try:
            size = db_path.stat().st_size
            with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
                session_count = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
            return {
                "size": size,
                "size_formatted": self.format_size(size),
                "session_count": session_count,
            }
        except Exception:
            return None

    def get_profile_info(self, profile: str | None = None) -> dict:
        """获取 profile 详细信息"""
        info = self.profiles.get_profile_info(profile)
        profile_root = self.profiles.profile_root(profile)

        result = {
            "name": info.name,
            "path": str(profile_root),
            "exists": info.exists,
            "config_exists": info.config_path.exists(),
            "env_exists": info.env_path.exists(),
            "state_db_exists": info.state_db_path.exists(),
            "skills_path": str(info.skills_path),
            "skills_exists": info.skills_path.exists(),
        }

        # 获取数据库统计
        if info.state_db_path.exists():
            result["db_stats"] = self.get_db_stats(info.state_db_path)
        else:
            result["db_stats"] = None

        return result

    def get_all_profiles_info(self) -> list[dict]:
        """获取所有 profile 信息"""
        profiles = self.profiles.list_profiles()
        return [self.get_profile_info(p) for p in profiles]

    def get_system_versions(self) -> dict:
        """获取系统组件版本"""
        versions = {}

        # Hermes (优先获取)
        hermes_version = self.get_command_version("hermes")
        if hermes_version:
            # 解析 Hermes 版本，提取版本号和日期
            # 格式通常是 "v0.17.0 (2026.6.19)" 或类似
            import re
            match = re.search(r'(v[\d.]+(?:\s*\([^)]+\))?)', hermes_version)
            if match:
                versions["hermes"] = match.group(1).strip()
            else:
                versions["hermes"] = hermes_version

        # Python
        import sys
        versions["python"] = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"

        # Node.js
        node_version = self.get_command_version("node")
        if node_version:
            versions["node"] = node_version

        # npm
        npm_version = self.get_command_version("npm")
        if npm_version:
            versions["npm"] = npm_version

        # Git - 只提取版本号
        git_version = self.get_command_version("git")
        if git_version:
            # 格式通常是 "git version 2.39.5"
            import re
            match = re.search(r'(\d+\.\d+(?:\.\d+)?)', git_version)
            if match:
                versions["git"] = match.group(1)
            else:
                versions["git"] = git_version

        return versions

    def get_hermes_home_info(self) -> dict:
        """获取 Hermes 主目录信息"""
        home_path = self.hermes_home
        exists = home_path.exists()

        return {
            "path": str(home_path),
            "exists": exists,
        }

    def get_dashboard_info(self, current_user: User | None = None) -> dict:
        """获取仪表盘所需的所有信息，只返回当前用户可见的 profile"""
        all_profiles = self.get_all_profiles_info()
        
        # 如果有用户信息，过滤出该用户可见的 profile
        if current_user:
            if "*" in current_user.profiles:
                # admin 用户可以看到所有 profile
                visible_profiles = all_profiles
            else:
                # 普通用户只能看到被授权的 profile
                visible_profiles = [p for p in all_profiles if p["name"] in current_user.profiles]
        else:
            visible_profiles = all_profiles
        
        return {
            "hermes_home": self.get_hermes_home_info(),
            "profiles": visible_profiles,
            "versions": self.get_system_versions(),
        }
