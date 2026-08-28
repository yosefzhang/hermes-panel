"""Admin bulk operations across multiple profiles.

Batch endpoints that apply a single action to several profiles at once.
All endpoints require the ``admin`` role and reuse the same underlying
services as the single-profile endpoints (``GatewayService``, ``YamlService``,
``ProfileService``), so behaviour stays consistent with the per-profile pages.
"""
from __future__ import annotations

import logging
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from backend.api.models_config import MODEL_SECTIONS
from backend.api.profile_files import _resolve_soul_path
from backend.auth.dependencies import require_admin
from backend.db.models import User
from backend.services.audit_log import log_audit_event
from backend.services.cli_utils import atomic_write_text
from backend.services.env_service import EnvService
from backend.services.gateway_service import GatewayService
from backend.services.profile_service import ProfileService
from backend.services.yaml_service import YamlService


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])

_VALID_GATEWAY_ACTIONS = {"start", "stop", "restart"}


# ── Pydantic request models ───────────────────────────────────────────────


class GatewayBatchRequest(BaseModel):
    action: str = Field(..., description="start / stop / restart")
    profiles: list[str] = Field(..., min_length=1)


class ModelsCopyRequest(BaseModel):
    profiles: list[str] = Field(..., min_length=1)
    source_profile: str
    sections: list[str] = Field(..., min_length=1)


class ModelsSetRequest(BaseModel):
    profiles: list[str] = Field(..., min_length=1)
    values: dict[str, Any] = Field(..., min_length=1)


class SoulBatchRequest(BaseModel):
    profiles: list[str] = Field(..., min_length=1)
    content: str


# ── Helpers ───────────────────────────────────────────────────────────────


def _client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def _backup_file(path: Path) -> None:
    """Back up *path* to ``<name>.<timestamp>.bak`` before overwriting.

    Mirrors ``YamlService._backup`` so SOUL.md bulk writes get the same
    safety net as config.yaml writes.
    """
    if not path.exists():
        return
    backup = path.with_name(f"{path.name}.{int(time.time())}.bak")
    shutil.copy2(path, backup)


def _audit(
    request: Request,
    user: User,
    action: str,
    profiles: list[str],
    results: list[dict],
) -> None:
    succeeded = sum(1 for r in results if r.get("success"))
    log_audit_event(
        request.app.state.settings,
        action=action,
        actor=user.username,
        target_type="profiles",
        target_id=",".join(profiles),
        details={
            "profiles": profiles,
            "total": len(profiles),
            "succeeded": succeeded,
            "failed": len(profiles) - succeeded,
            "results": results,
        },
        success=(succeeded == len(profiles)),
        ip_address=_client_ip(request),
    )


# ── Gateway batch ─────────────────────────────────────────────────────────


@router.post("/gateway/batch")
def gateway_batch(
    request: Request,
    body: GatewayBatchRequest,
    user: User = Depends(require_admin),
):
    """Batch start/stop/restart gateways for multiple profiles."""
    if body.action not in _VALID_GATEWAY_ACTIONS:
        raise HTTPException(status_code=400, detail=f"Invalid action: {body.action}")

    def _run_one(profile: str) -> dict:
        # 每个线程独立一个 service 实例，避免并发下状态串扰
        service = GatewayService()
        try:
            result = getattr(service, body.action)(profile)
            return {
                "profile": profile,
                "success": bool(result.get("success")),
                "message": str(result.get("message") or ""),
                "status": result.get("status"),
            }
        except Exception as exc:  # noqa: BLE001 - report per-profile errors
            logger.exception("admin gateway_batch: profile=%s failed", profile)
            return {"profile": profile, "success": False, "message": str(exc)}

    # 并发执行，缩短批量耗时；pool.map 保持与请求一致的顺序
    with ThreadPoolExecutor(max_workers=min(len(body.profiles), 16)) as pool:
        results = list(pool.map(_run_one, body.profiles))

    _audit(request, user, f"admin:gateway:{body.action}", body.profiles, results)
    return {"results": results}


# ── Models batch ──────────────────────────────────────────────────────────


def _apply_model_copy(
    yaml_svc: YamlService, source: str, profiles: list[str], sections: list[str]
) -> list[dict]:
    source_config = yaml_svc.read_config(source)
    # 收集同步范围内会带走的 provider 密钥环境变量（key_env 指向 .env）。
    # inline api_key 随 custom_providers section 一并复制，无需单独处理。
    env_svc = EnvService(yaml_svc.profiles.hermes_home)
    source_env = env_svc.read_env(source)
    key_envs_to_copy: set[str] = set()
    if "custom_providers" in sections and isinstance(source_config, dict):
        cp_list = source_config.get("custom_providers", [])
        if isinstance(cp_list, list):
            for cp in cp_list:
                if isinstance(cp, dict):
                    key_env = str(cp.get("key_env") or "").strip()
                    if key_env and source_env.get(key_env):
                        key_envs_to_copy.add(key_env)

    results: list[dict] = []
    for profile in profiles:
        try:
            if profile == source:
                results.append(
                    {"profile": profile, "success": True, "message": "源 profile，跳过"}
                )
                continue
            for section in sections:
                value = source_config.get(section) if isinstance(source_config, dict) else None
                yaml_svc.write_section(profile, section, value)
            # 把源 profile 的 provider 密钥写入目标 .env（只写被同步用到的变量）
            if key_envs_to_copy:
                updates: dict[str, str | None] = {k: source_env[k] for k in key_envs_to_copy}
                env_svc.write_env(profile, updates)
            copied_note = (
                f"已复制 {len(sections)} 个 section，密钥 {len(key_envs_to_copy)} 个"
                if key_envs_to_copy
                else f"已复制 {len(sections)} 个 section"
            )
            results.append(
                {
                    "profile": profile,
                    "success": True,
                    "message": copied_note,
                }
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("admin models copy: profile=%s failed", profile)
            results.append({"profile": profile, "success": False, "message": str(exc)})
    return results


def _apply_model_set(
    yaml_svc: YamlService, profiles: list[str], values: dict[str, Any]
) -> list[dict]:
    results: list[dict] = []
    for profile in profiles:
        try:
            for section, value in values.items():
                yaml_svc.write_section(profile, section, value)
            results.append(
                {
                    "profile": profile,
                    "success": True,
                    "message": f"已设置 {len(values)} 个 section",
                }
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("admin models set: profile=%s failed", profile)
            results.append({"profile": profile, "success": False, "message": str(exc)})
    return results


@router.post("/models/copy")
def models_copy(
    request: Request,
    body: ModelsCopyRequest,
    user: User = Depends(require_admin),
):
    """Copy model-related sections from a source profile to many targets."""
    for section in body.sections:
        if section not in MODEL_SECTIONS:
            raise HTTPException(status_code=400, detail=f"Invalid section: {section}")

    yaml_svc = YamlService()
    results = _apply_model_copy(
        yaml_svc, body.source_profile, body.profiles, body.sections
    )
    _audit(request, user, "admin:models:copy", body.profiles, results)
    return {"results": results}


@router.post("/models/set")
def models_set(
    request: Request,
    body: ModelsSetRequest,
    user: User = Depends(require_admin),
):
    """Overwrite model-related section values across many profiles."""
    for section in body.values:
        if section not in MODEL_SECTIONS:
            raise HTTPException(status_code=400, detail=f"Invalid section: {section}")

    yaml_svc = YamlService()
    results = _apply_model_set(yaml_svc, body.profiles, body.values)
    _audit(request, user, "admin:models:set", body.profiles, results)
    return {"results": results}


# ── SOUL batch ────────────────────────────────────────────────────────────


@router.post("/soul/batch")
def soul_batch(
    request: Request,
    body: SoulBatchRequest,
    user: User = Depends(require_admin),
):
    """Overwrite SOUL.md for multiple profiles (with backup before write)."""
    profile_svc = ProfileService()
    results: list[dict] = []
    for profile in body.profiles:
        try:
            root = profile_svc.profile_root(profile)
            soul_path = _resolve_soul_path(root)
            soul_path.parent.mkdir(parents=True, exist_ok=True)
            _backup_file(soul_path)
            atomic_write_text(soul_path, body.content)
            results.append(
                {"profile": profile, "success": True, "message": "SOUL.md 已更新"}
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("admin soul batch: profile=%s failed", profile)
            results.append({"profile": profile, "success": False, "message": str(exc)})

    _audit(request, user, "admin:soul:batch", body.profiles, results)
    return {"results": results}
