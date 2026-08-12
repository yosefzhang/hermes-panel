"""Subprocess execution utilities.

The panel calls hermes CLI with `hermes -p <profile>` format.
It is NOT bound to any profile, so every subprocess must explicitly set
``HERMES_HOME`` to the correct directory (base ``~/.hermes`` or a profile
home) and drop any inherited ``HERMES_PROFILE`` binding.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any


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
    **kwargs: Any
) -> subprocess.CompletedProcess:
    """Run a subprocess command with a clean environment.

    Args:
        cmd: Command to execute
        **kwargs: Additional arguments passed to subprocess.run()

    Returns:
        CompletedProcess instance
    """
    env = get_clean_env()
    return subprocess.run(cmd, env=env, **kwargs)
