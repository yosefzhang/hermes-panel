"""Locate Hermes CLIs and build a per-profile command prefix.

The panel shells out to the local `hermes` CLI (or a profile-named shim)
for several features: plugins, skills list, gateway control, upgrade, etc.
This module centralises the resolution rules so the individual service
files don't drift apart.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

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

    Rules:
      * default (or None) -> use the global `hermes` command
      * any other profile -> prefer a same-named shim (e.g. `xiaokui`),
        falling back to `hermes -p <profile>`.

    Returns None if neither the shim nor `hermes` is on PATH.
    """
    if not profile or profile == "default":
        hermes = find_command("hermes")
        return [hermes] if hermes else None

    shim = find_command(profile)
    if shim:
        return [shim]

    hermes = find_command("hermes")
    if hermes:
        return [hermes, "-p", profile]
    return None
