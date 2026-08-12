"""Locate Hermes CLIs and build a per-profile command prefix.

The panel shells out to the local `hermes` CLI for several features:
plugins, skills list, gateway control, upgrade, etc.
This module centralises the resolution rules so the individual service
files don't drift apart.

IMPORTANT: The panel uses `hermes -p <profile>` format to target specific profiles.
It does NOT use profile-named shims (e.g. `xiaokui`).
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

    Always uses `hermes -p <profile>` format for non-default profiles.
    Does NOT use profile-named shims.

    Returns None if `hermes` is not on PATH.
    """
    hermes = find_command("hermes")
    if not hermes:
        return None

    if not profile or profile == "default":
        return [hermes]

    # Always use `hermes -p <profile>` format
    return [hermes, "-p", profile]
