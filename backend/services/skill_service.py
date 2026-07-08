from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from io import StringIO
from pathlib import Path

from ruamel.yaml import YAML

from .atomic_io import atomic_write_text
from .cli_runner import get_profile_cmd_prefix
from .profile_service import ProfileService

SKILL_SOURCE_BUILTIN = "builtin"
SKILL_SOURCE_HUB = "hub"
SKILL_SOURCE_LOCAL = "local"
SKILL_SOURCE_EXTERNAL = "external"
SKILL_SOURCE_MODIFIED = "modified"

# Origin: a semantic classification derived from "author × source".
# Frontend uses this to badge "Agent created" vs "I wrote this" vs
# "community" vs "official".
SKILL_ORIGIN_AGENT_CREATED = "agent_created"
SKILL_ORIGIN_AGENT_MODIFIED = "agent_modified"
SKILL_ORIGIN_USER = "user"
SKILL_ORIGIN_COMMUNITY = "community"
SKILL_ORIGIN_OFFICIAL = "official"
SKILL_ORIGIN_UNKNOWN = "unknown"

# Substring markers (case-insensitive) used to classify authors.
_USER_AUTHOR_MARKERS = ("yosef", "yosephine")
_AGENT_AUTHOR_MARKERS = ("hermes agent", "hermes-agent")


def _derive_origin(source: str, author: str | None) -> str:
    """Classify a skill by its source + author signature."""
    src = (source or "").lower()
    if src == SKILL_SOURCE_MODIFIED:
        return SKILL_ORIGIN_AGENT_MODIFIED
    if src == SKILL_SOURCE_BUILTIN:
        return SKILL_ORIGIN_OFFICIAL

    author_norm = (author or "").strip().lower()
    if any(marker in author_norm for marker in _AGENT_AUTHOR_MARKERS):
        return SKILL_ORIGIN_AGENT_CREATED
    if any(marker in author_norm for marker in _USER_AUTHOR_MARKERS):
        return SKILL_ORIGIN_USER
    if src in (SKILL_SOURCE_HUB, SKILL_SOURCE_EXTERNAL, "skills.sh", "community"):
        return SKILL_ORIGIN_COMMUNITY
    if src == SKILL_SOURCE_LOCAL and not author_norm:
        return SKILL_ORIGIN_AGENT_CREATED
    if author_norm:
        return SKILL_ORIGIN_COMMUNITY
    return SKILL_ORIGIN_UNKNOWN


def _parse_skills_table(output: str) -> list[dict]:
    """Parse the pipe-delimited table from `hermes skills list`."""
    skills: list[dict] = []
    for raw_line in output.splitlines():
        line = raw_line.rstrip()
        if "│" not in line or not line.strip().startswith("│"):
            continue
        parts = line.strip().split("│")
        if parts and parts[0].strip() == "":
            parts = parts[1:]
        if parts and parts[-1].strip() == "":
            parts = parts[:-1]
        cells = [c.strip() for c in parts]
        if len(cells) < 5:
            continue
        name, category, source, trust, status = cells[:5]
        if name == "Name":  # header row
            continue
        skills.append({
            "name": name,
            "category": category or "未分类",
            "source": source,
            "trust": trust,
            "status": status,
            "enabled": status.lower() == "enabled",
        })
    return skills


def _read_manifest(manifest_path: Path) -> dict[str, str]:
    """Read .bundled_manifest, return {name: md5_hash}."""
    if not manifest_path.exists():
        return {}
    result: dict[str, str] = {}
    for line in manifest_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        name, hash_val = line.split(":", 1)
        result[name.strip()] = hash_val.strip()
    return result


def _md5_of(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def _detect_source(
    name: str,
    skill_path: Path,
    skills_base: Path,
    bundled: dict[str, str],
    external_dirs: list[Path],
    webui_managed: set[str] | None = None,
) -> str:
    """Determine a skill's source: builtin, modified, hub, local, external."""
    for ext_dir in external_dirs:
        if ext_dir in skill_path.parents:
            return SKILL_SOURCE_EXTERNAL

    hub_dir = skills_base / "hub"
    if hub_dir.exists() and hub_dir in skill_path.parents:
        return SKILL_SOURCE_HUB

    if webui_managed and name in webui_managed:
        return SKILL_SOURCE_HUB

    if name in bundled:
        sk_file = skill_path / "SKILL.md" if skill_path.is_dir() else skill_path
        if sk_file.exists() and _md5_of(sk_file) != bundled[name]:
            return SKILL_SOURCE_MODIFIED
        return SKILL_SOURCE_BUILTIN

    return SKILL_SOURCE_LOCAL


@dataclass(frozen=True)
class SkillSummary:
    name: str
    category: str
    path: str
    description: str | None
    enabled: bool
    source: str = SKILL_SOURCE_LOCAL
    author: str | None = None
    origin: str = SKILL_ORIGIN_UNKNOWN


class SkillService:
    def __init__(self, hermes_home: str | Path | None = None):
        self.profiles = ProfileService(hermes_home)
        self.yaml = YAML(typ="safe")

    # ── listing ────────────────────────────────────────────

    def list_skills(self, profile: str | None = None) -> list[dict]:
        base = self.profiles.get_skills_path(profile)
        if not base.exists():
            return []

        bundled = _read_manifest(base / ".bundled_manifest")
        webui_managed = self._read_webui_managed(base)
        external_dirs = [
            Path(d).expanduser().resolve() for d in self.get_external_dirs(profile) if d
        ]

        skills: list[dict] = []
        for skill_file in sorted(base.glob("**/SKILL.md")):
            relative = skill_file.relative_to(base)
            category = relative.parts[0] if len(relative.parts) > 2 else "general"
            name = relative.parts[-2]
            frontmatter, _ = self._parse(skill_file.read_text(encoding="utf-8"))
            skill_name = str(frontmatter.get("name") or name)

            enabled = not (skill_file.parent / ".disabled").exists()
            source = _detect_source(
                skill_name, skill_file.parent, base, bundled, external_dirs, webui_managed
            )
            author_raw = frontmatter.get("author")
            author = str(author_raw).strip() if author_raw else None
            origin = _derive_origin(source, author)

            skills.append(
                SkillSummary(
                    name=skill_name,
                    category=category,
                    path=str(relative),
                    description=frontmatter.get("description"),
                    enabled=enabled,
                    source=source,
                    author=author,
                    origin=origin,
                ).__dict__
            )
        return skills

    def list_modified_names(self, profile: str | None = None) -> set[str]:
        """Authoritative list of modified-but-original-bundled skills.

        `hermes skills list` shows modified skills as builtin, so we need
        the dedicated `list-modified` subcommand to distinguish them.
        """
        cmd = get_profile_cmd_prefix(profile)
        if not cmd:
            return set()
        env = os.environ.copy()
        env["COLUMNS"] = "400"
        try:
            result = subprocess.run(
                [*cmd, "skills", "list-modified"],
                capture_output=True,
                text=True,
                timeout=30,
                env=env,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError):
            return set()
        if result.returncode != 0:
            return set()
        return {
            stripped[2:].strip()
            for line in result.stdout.splitlines()
            if (stripped := line.strip()).startswith("~ ")
        }

    def list_skills_cli(self, profile: str | None = None) -> list[dict]:
        """Use the `hermes skills list` CLI as the source of truth when available."""
        cmd = get_profile_cmd_prefix(profile)
        if not cmd:
            return []
        env = os.environ.copy()
        env["COLUMNS"] = "400"  # avoid truncation of long names
        try:
            result = subprocess.run(
                [*cmd, "skills", "list"],
                capture_output=True,
                text=True,
                timeout=30,
                env=env,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError):
            return []
        if result.returncode != 0:
            return []
        return _parse_skills_table(result.stdout)

    # ── read / write / delete ──────────────────────────────

    def read_skill(self, profile: str | None, name: str) -> dict:
        path = self._find_skill(profile, name)
        content = path.read_text(encoding="utf-8")
        frontmatter, body = self._parse(content)
        return {
            "name": name,
            "path": str(path),
            "frontmatter": frontmatter,
            "body": body,
            "content": content,
        }

    def write_skill(self, profile: str | None, name: str, content: str) -> dict:
        path = self._skill_path(profile, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(path, content)
        return self.read_skill(profile, name)

    def delete_skill(self, profile: str | None, name: str) -> None:
        path = self._find_skill(profile, name)
        shutil.rmtree(path.parent)

    def toggle_skill(self, profile: str | None, name: str, enabled: bool) -> dict:
        """Enable/disable by editing skills.disabled in config.yaml."""
        config = self._load_config(profile)
        skills_cfg = config.setdefault("skills", {})
        disabled = skills_cfg.get("disabled")
        if not isinstance(disabled, list):
            disabled = []
        if enabled:
            disabled = [d for d in disabled if d != name]
        elif name not in disabled:
            disabled.append(name)
        skills_cfg["disabled"] = disabled
        self._dump_config(profile, config)
        return {"name": name, "enabled": enabled}

    # ── external dirs ──────────────────────────────────────

    def get_external_dirs(self, profile: str | None) -> list[str]:
        config = self._load_config(profile)
        ext = config.get("skills", {}).get("external_dirs", [])
        return [str(d) for d in ext] if isinstance(ext, list) else []

    def set_external_dirs(self, profile: str | None, dirs: list[str]) -> None:
        config = self._load_config(profile)
        config.setdefault("skills", {})["external_dirs"] = dirs
        self._dump_config(profile, config)

    # ── import / helpers ───────────────────────────────────

    def import_skill(
        self,
        profile: str | None,
        name: str,
        content: str,
        source: str = SKILL_SOURCE_LOCAL,
    ) -> dict:
        path = self._skill_path(profile, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(path, content)
        return self.read_skill(profile, name)

    # ── internals ──────────────────────────────────────────

    def _skill_path(self, profile: str | None, name: str) -> Path:
        safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "-", name).strip("-") or "skill"
        return self.profiles.get_skills_path(profile) / "custom" / safe_name / "SKILL.md"

    def _find_skill(self, profile: str | None, name: str) -> Path:
        base = self.profiles.get_skills_path(profile)
        candidate = self._skill_path(profile, name)
        if candidate.exists():
            return candidate
        for skill_file in base.glob("**/SKILL.md"):
            if skill_file.parent.name == name:
                return skill_file
            frontmatter, _ = self._parse(skill_file.read_text(encoding="utf-8"))
            if frontmatter.get("name") == name:
                return skill_file
        raise FileNotFoundError(name)

    def _parse(self, content: str) -> tuple[dict, str]:
        if not content.startswith("---\n"):
            return {}, content
        _, frontmatter_text, body = content.split("---", 2)
        return self.yaml.load(frontmatter_text) or {}, body.lstrip("\n")

    def _load_config(self, profile: str | None) -> dict:
        path = self.profiles.get_config_path(profile)
        if not path.exists():
            return {}
        return self.yaml.load(path.read_text(encoding="utf-8")) or {}

    def _dump_config(self, profile: str | None, config: dict) -> None:
        path = self.profiles.get_config_path(profile)
        buffer = StringIO()
        ryaml = YAML()
        ryaml.dump(config, buffer)
        atomic_write_text(path, buffer.getvalue())

    @staticmethod
    def _read_webui_managed(base: Path) -> set[str]:
        path = base / ".webui-managed-skills.json"
        if not path.exists():
            return set()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return set()
        return set(data.keys()) if isinstance(data, dict) else set()
