"""Profile-wide file browser: config.yaml, .env, SOUL/USER/MEMORY markdown."""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel

from backend.auth.dependencies import ensure_profile_access, get_current_user
from backend.db.models import User
from backend.services.profile_service import ProfileService


router = APIRouter(prefix="/profile-files", tags=["profile-files"])


# Heuristic: any key whose name contains one of these substrings is
# treated as a credential and its value is masked on read.
_SECRET_KEY_HINT = re.compile(r"(KEY|SECRET|TOKEN|PASSWORD|PASSWD|API)", re.IGNORECASE)
_MASK_KEEP = 3  # chars of the value to keep on each side of the mask


class ProfileFile(BaseModel):
    name: str
    path: str
    exists: bool
    masked: bool = False
    content: str = ""


def profile_service(request: Request) -> ProfileService:
    return ProfileService()


def _mask_value(value: str) -> str:
    if not value:
        return value
    if len(value) <= _MASK_KEEP * 2:
        return "***"
    return f"{value[:_MASK_KEEP]}***{value[-_MASK_KEEP:]}"


def _mask_env_content(content: str) -> str:
    """Mask the value of any KEY=... line whose key looks like a credential.

    Preserves the original line endings (trailing newline included).
    """
    if not content:
        return content
    trailing_newline = "\n" if content.endswith("\n") else ""
    out: list[str] = []
    for line in content.splitlines():
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            out.append(line)
            continue
        key, _, value = line.partition("=")
        if _SECRET_KEY_HINT.search(key.strip()):
            out.append(f"{key}={_mask_value(value.strip())}")
        else:
            out.append(line)
    return "\n".join(out) + trailing_newline


def _build_file_list(profile_root: Path) -> list[ProfileFile]:
    """Return the canonical set of files for *profile_root*.

    `.env` is flagged as `masked` and its value is scrubbed before
    being returned to the client.
    """
    candidates: list[tuple[str, Path, bool]] = [
        ("config.yaml", profile_root / "config.yaml", False),
        (".env", profile_root / ".env", True),
        ("SOUL.md", profile_root / "SOUL.md", False),
        ("USER.md", profile_root / "memories" / "USER.md", False),
        ("MEMORY.md", profile_root / "memories" / "MEMORY.md", False),
    ]
    files: list[ProfileFile] = []
    for name, path, masked in candidates:
        entry = ProfileFile(
            name=name,
            path=str(path),
            exists=path.exists(),
            masked=masked,
        )
        if entry.exists:
            entry.content = path.read_text(encoding="utf-8")
            if masked:
                entry.content = _mask_env_content(entry.content)
        files.append(entry)
    return files


@router.get("")
def get_profile_files(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    profiles: ProfileService = Depends(profile_service),
):
    ensure_profile_access(user, profile)
    root = profiles.profile_root(profile)
    return {"files": _build_file_list(root)}
