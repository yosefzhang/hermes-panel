from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel

from backend.auth.dependencies import ensure_profile_access, get_current_user
from backend.db.models import User
from backend.services.skill_service import SkillService


router = APIRouter(prefix="/skills", tags=["skills"])


class SkillPayload(BaseModel):
    name: str | None = None
    content: str


class TogglePayload(BaseModel):
    enabled: bool


class ImportPayload(BaseModel):
    name: str
    content: str
    source: str = "local"


class ExternalDirsPayload(BaseModel):
    dirs: list[str]


def skill_service(request: Request) -> SkillService:
    return SkillService()


@router.get("")
def list_skills(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: SkillService = Depends(skill_service),
):
    resolved = ensure_profile_access(user, profile)
    cli_skills = service.list_skills_cli(resolved)
    if cli_skills:
        # 合并本地扫描得到的 description/author + 权威 modified 集合
        local = {s["name"]: s for s in service.list_skills(resolved)}
        modified_names = service.list_modified_names(resolved)
        from ..services.skill_service import (
            _derive_origin,
            SKILL_SOURCE_MODIFIED,
            SKILL_SOURCE_BUILTIN,
        )
        for s in cli_skills:
            match = local.get(s["name"]) or {}
            s["description"] = match.get("description")
            s["path"] = match.get("path", "")
            s["author"] = match.get("author")
            # 若在 list-modified 结果中，把 builtin 升级为 modified
            if s["name"] in modified_names and s.get("source") == SKILL_SOURCE_BUILTIN:
                s["source"] = SKILL_SOURCE_MODIFIED
            s["origin"] = _derive_origin(s.get("source", ""), s.get("author"))
        return {"skills": cli_skills}
    # CLI 不可用时回退到本地扫描
    return {"skills": service.list_skills(resolved)}


@router.get("/{name}")
def get_skill(
    name: str,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: SkillService = Depends(skill_service),
):
    try:
        return service.read_skill(ensure_profile_access(user, profile), name)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Skill not found") from error


@router.post("", status_code=status.HTTP_201_CREATED)
def create_skill(
    payload: SkillPayload,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: SkillService = Depends(skill_service),
):
    name = payload.name or "skill"
    return service.write_skill(ensure_profile_access(user, profile), name, payload.content)


@router.put("/{name}")
def update_skill(
    name: str,
    payload: SkillPayload,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: SkillService = Depends(skill_service),
):
    return service.write_skill(ensure_profile_access(user, profile), name, payload.content)


@router.delete("/{name}")
def delete_skill(
    name: str,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: SkillService = Depends(skill_service),
):
    try:
        service.delete_skill(ensure_profile_access(user, profile), name)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Skill not found") from error
    return {"ok": True}


@router.post("/{name}/toggle")
def toggle_skill(
    name: str,
    payload: TogglePayload,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: SkillService = Depends(skill_service),
):
    """Enable or disable a skill."""
    try:
        return service.toggle_skill(ensure_profile_access(user, profile), name, payload.enabled)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Skill not found") from error


@router.post("/import", status_code=status.HTTP_201_CREATED)
def import_skill(
    payload: ImportPayload,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: SkillService = Depends(skill_service),
):
    """Import a skill from raw content."""
    return service.import_skill(
        ensure_profile_access(user, profile),
        payload.name,
        payload.content,
        payload.source,
    )


@router.get("/external-dirs")
def get_external_dirs(
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: SkillService = Depends(skill_service),
):
    return {"dirs": service.get_external_dirs(ensure_profile_access(user, profile))}


@router.put("/external-dirs")
def set_external_dirs(
    payload: ExternalDirsPayload,
    profile: str = Query("default"),
    user: User = Depends(get_current_user),
    service: SkillService = Depends(skill_service),
):
    service.set_external_dirs(ensure_profile_access(user, profile), payload.dirs)
    return {"ok": True}
