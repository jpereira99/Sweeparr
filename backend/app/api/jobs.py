"""Scheduler control + history + audit ledger (§7.2, §13)."""

from __future__ import annotations

from datetime import timezone
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import AuditLog, JobRun, MediaItem
from ..services import scheduler
from .auth import Principal, require_admin

router = APIRouter(prefix="/api/v1", tags=["jobs"])

GB = 1024**3


@router.get("/jobs")
async def list_jobs(
    session: AsyncSession = Depends(get_session), _: Principal = Depends(require_admin)
):
    states = scheduler.job_states()
    runs = (
        (
            await session.execute(
                select(JobRun).order_by(JobRun.started_at.desc()).limit(30)
            )
        )
        .scalars()
        .all()
    )
    history = [
        {
            "job": r.job_name,
            "status": r.status,
            "summary": r.summary,
            "started_at": r.started_at.replace(tzinfo=timezone.utc).isoformat(),
            "finished_at": (
                r.finished_at.replace(tzinfo=timezone.utc).isoformat()
                if r.finished_at
                else None
            ),
        }
        for r in runs
    ]
    return {"jobs": states, "history": history}


@router.post("/jobs/{name}/run")
async def run_job(name: str, _: Principal = Depends(require_admin)):
    result = await scheduler.run_now(name)
    return {"ok": True, "summary": result}


@router.post("/jobs/{name}/pause")
async def pause_job(name: str, _: Principal = Depends(require_admin)):
    scheduler.pause_job(name)
    return {"ok": True}


@router.post("/jobs/{name}/resume")
async def resume_job(name: str, _: Principal = Depends(require_admin)):
    scheduler.resume_job(name)
    return {"ok": True}


@router.get("/history")
async def history(
    action: Optional[str] = None,
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
):
    stmt = select(AuditLog).order_by(AuditLog.ts.desc()).limit(200)
    if action:
        stmt = stmt.where(AuditLog.action == action)
    rows = (await session.execute(stmt)).scalars().all()

    # Resolve real media titles once (audit rows never store a title).
    item_ids = {r.media_item_id for r in rows if r.media_item_id is not None}
    titles: dict[int, str] = {}
    if item_ids:
        for iid, title in (
            await session.execute(
                select(MediaItem.id, MediaItem.title).where(MediaItem.id.in_(item_ids))
            )
        ).all():
            titles[iid] = title

    entries = [
        {
            "ts": r.ts.replace(tzinfo=timezone.utc).isoformat(),
            "action": r.action,
            "actor": r.actor,
            "unit_type": r.unit_type,
            "unit_id": r.unit_id,
            "media_item_id": r.media_item_id,
            "title": (
                (r.detail or {}).get("title")
                or titles.get(r.media_item_id)
                or (r.detail or {}).get("rule")
            ),
            "detail": r.detail,
        }
        for r in rows
    ]
    total_freed = sum(
        (r.detail or {}).get("bytes_freed", 0) for r in rows if r.action == "deleted"
    )
    return {"entries": entries, "total_freed_gb": round(total_freed / GB, 1)}
