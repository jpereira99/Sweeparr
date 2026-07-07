"""Dashboard + stats endpoints (§12, §13)."""
from __future__ import annotations

from datetime import timezone

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import AuditLog, JobRun, LifecycleState, MediaItem, Season, utcnow
from ..services import lifecycle
from ..services.integrations import get_integrations
from ..services.runtime import all_settings, is_system_enabled
from .auth import Principal, require_admin
from .serializers import serialize_movie, serialize_season

router = APIRouter(prefix="/api/v1", tags=["dashboard"])

GB = 1024 ** 3


async def _scheduled_units(session: AsyncSession, states: list[str]):
    units = []
    movies = (await session.execute(select(MediaItem).where(MediaItem.type == "movie", MediaItem.state.in_(states)))).scalars().all()
    for m in movies:
        units.append(await serialize_movie(session, m))
    rows = (
        await session.execute(
            select(Season, MediaItem).join(MediaItem, Season.media_item_id == MediaItem.id).where(Season.state.in_(states))
        )
    ).all()
    for s, item in rows:
        units.append(await serialize_season(session, item, s))
    return units


@router.get("/dashboard")
async def dashboard(session: AsyncSession = Depends(get_session), _: Principal = Depends(require_admin)):
    settings = await all_settings(session)
    disk = settings.get("disk", {})
    capacity = settings.get("disk_capacity_tb", {})
    tiers = settings.get("disk_pressure_tiers", [])
    gauges = []
    for root, pct in disk.items():
        cap = capacity.get(root, 10.0)
        over_tier = None
        for i, t in enumerate(sorted(tiers, key=lambda x: x["usage_pct"])):
            if pct >= t["usage_pct"]:
                over_tier = i + 1
        gauges.append({
            "root": root, "pct": pct, "used_tb": round(cap * pct / 100, 1), "capacity_tb": cap,
            "over_tier": over_tier, "warn_pct": tiers[0]["usage_pct"] if tiers else 85,
        })

    scheduled = await _scheduled_units(session, [LifecycleState.SCHEDULED.value, LifecycleState.ERROR.value])
    leaving = sorted([u for u in scheduled if u["days_until"] is not None], key=lambda u: u["days_until"])
    leaving_week = [u for u in leaving if u["days_until"] <= 7]

    # bytes freed cumulative
    deleted = (await session.execute(select(AuditLog).where(AuditLog.action == "deleted").order_by(AuditLog.ts))).scalars().all()
    cumulative = []
    running = 0
    for d in deleted:
        running += (d.detail or {}).get("bytes_freed", 0)
        cumulative.append({"ts": d.ts.replace(tzinfo=timezone.utc).isoformat(), "cumulative_gb": round(running / GB, 1)})
    total_freed_tb = round(running / (GB * 1024), 2)

    jobs = (await session.execute(select(JobRun).order_by(JobRun.started_at.desc()).limit(6))).scalars().all()
    recent_jobs = [{
        "job": j.job_name, "status": j.status, "summary": j.summary,
        "at": j.started_at.replace(tzinfo=timezone.utc).isoformat(),
    } for j in jobs]

    return {
        "scheduled_count": len([u for u in scheduled if u["state"] == "SCHEDULED"]),
        "scheduled_gb": round(sum(u["size_gb"] for u in scheduled if u["state"] == "SCHEDULED"), 1),
        "disk_gauges": gauges,
        "leaving_week": leaving_week,
        "leaving_week_gb": round(sum(u["size_gb"] for u in leaving_week), 1),
        "bytes_freed_series": cumulative,
        "total_freed_tb": total_freed_tb,
        "integrations": get_integrations().health(),
        "recent_jobs": recent_jobs,
        "system_enabled": await is_system_enabled(session),
    }


@router.get("/stats/library")
async def stats_library(session: AsyncSession = Depends(get_session), _: Principal = Depends(require_admin)):
    by_lib = (
        await session.execute(
            select(MediaItem.library, func.count(), func.sum(MediaItem.size_bytes)).group_by(MediaItem.library)
        )
    ).all()
    return {
        "libraries": [
            {"library": lib, "items": int(cnt), "size_gb": round((size or 0) / GB, 1)}
            for lib, cnt, size in by_lib
        ]
    }
