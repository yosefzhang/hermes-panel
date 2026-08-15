"""CLI execution, subprocess environment, and atomic IO utilities.

Consolidates three concerns that every service touching the Hermes CLI needs:

1. **CLI discovery** – locate ``hermes`` and other binaries on PATH or in
   common install locations.
2. **Subprocess environment** – build a clean env that pins ``HERMES_HOME``
   and drops inherited ``HERMES_PROFILE`` so subprocesses never leak into
   the wrong profile.
3. **Atomic file writes** – write config files via tmp-file + ``os.replace``
   so partial writes never corrupt user data.

The panel uses ``hermes -p <profile>`` format to target specific profiles.
It does NOT use profile-named shims (e.g. ``xiaokui``).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

# Common install locations checked after shutil.which().
COMMON_BIN_PATHS: tuple[str, ...] = (
    "~/.local/bin",
    "~/.hermes/hermes-agent/venv/bin",
    "/usr/local/bin",
)

# When looking for node / npm we may also want these extras.
EXTRA_BIN_PATHS: tuple[str, ...] = (
    "~/.local/nodejs/current/bin",
    "/opt/nodejs/bin",
)


# ── CLI discovery ──────────────────────────────────────────────────────────


def find_command(cmd_name: str, extra_paths: tuple[str, ...] = ()) -> str | None:
    """Return absolute path to *cmd_name* or None if not found."""
    found = shutil.which(cmd_name)
    if found:
        return found

    for raw in (*COMMON_BIN_PATHS, *extra_paths):
        candidate = Path(os.path.expanduser(raw)) / cmd_name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def get_profile_cmd_prefix(profile: str | None) -> list[str] | None:
    """Build a command prefix that targets a given profile.

    Always uses ``hermes -p <profile>`` format for non-default profiles.
    Returns None if ``hermes`` is not on PATH.
    """
    hermes = find_command("hermes")
    if not hermes:
        return None

    if not profile or profile == "default":
        return [hermes]

    return [hermes, "-p", profile]


# ── Subprocess environment ─────────────────────────────────────────────────


def _base_hermes_home() -> Path:
    """Return the current user's base Hermes home directory."""
    return Path.home() / ".hermes"


def get_clean_env(hermes_home: str | Path | None = None) -> dict[str, str]:
    """Get environment for global subprocess calls.

    Sets ``HERMES_HOME`` to the base Hermes directory (``~/.hermes``) and
    removes any inherited ``HERMES_PROFILE`` so the CLI does not fall back
    to the wrong profile when an ``active_profile`` file exists.
    """
    env = os.environ.copy()
    env.pop("HERMES_PROFILE", None)
    if hermes_home is None:
        hermes_home = _base_hermes_home()
    env["HERMES_HOME"] = str(hermes_home)
    return env


def get_profile_env(profile: str, hermes_home: str | Path | None = None) -> dict[str, str]:
    """Get environment for a subprocess that targets a specific profile.

    ``HERMES_HOME`` is scoped to the profile's home directory so Hermes CLI
    writes to the right place, while ``HERMES_PROFILE`` is cleared to avoid
    warnings. The command should still include ``-p <profile>``.
    """
    env = get_clean_env(hermes_home=hermes_home)
    base = Path(hermes_home) if hermes_home else _base_hermes_home()
    if profile and profile != "default":
        env["HERMES_HOME"] = str(base / "profiles" / profile)
    else:
        env["HERMES_HOME"] = str(base)
    return env


def run_with_clean_env(
    cmd: list[str],
    **kwargs: Any,
) -> subprocess.CompletedProcess:
    """Run a subprocess command with a clean environment.

    Args:
        cmd: Command to execute.
        **kwargs: Additional arguments passed to ``subprocess.run()``.
    """
    env = get_clean_env()
    return subprocess.run(cmd, env=env, **kwargs)


# ── Atomic file writes ─────────────────────────────────────────────────────


def atomic_write_text(path: Path, content: str) -> None:
    """Write *content* to *path* atomically (tmp file + ``os.replace``)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as tmp:
        tmp.write(content)
        tmp_path = Path(tmp.name)
    os.replace(tmp_path, path)


# ── Short-lived TTL cache ────────────────────────────────────────────────
#
# CLI-backed listing endpoints (skills / plugins) pay the cost of a hermes
# subprocess on every request, which dominates page load time. A tiny
# in-memory TTL cache avoids re-running those commands when a user navigates
# between pages repeatedly. Callers invalidate the relevant key after any
# mutation (enable/disable/import/delete) so edits show up immediately.


class TTLCache:
    """A minimal thread-safe TTL cache keyed by string.

    Dict reads/writes are atomic under the GIL, so worst-case concurrent
    access is a redundant subprocess call rather than corruption.
    """

    def __init__(self, ttl: float):
        self._ttl = ttl
        self._store: dict[str, tuple[float, Any]] = {}

    def get(self, key: str) -> Any | None:
        item = self._store.get(key)
        if item is None:
            return None
        ts, value = item
        if time.time() - ts > self._ttl:
            self._store.pop(key, None)
            return None
        return value

    def set(self, key: str, value: Any) -> None:
        self._store[key] = (time.time(), value)

    def invalidate(self, key: str) -> None:
        self._store.pop(key, None)

    def invalidate_prefix(self, prefix: str) -> None:
        for key in [k for k in self._store if k.startswith(prefix)]:
            self._store.pop(key, None)
