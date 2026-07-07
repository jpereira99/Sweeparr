"""Schedule feed (Upcoming Removals) + per-unit lifecycle actions (§12)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import LifecycleState, MediaItem, Season
from ..schemas import KeepIn, PostponeIn
from ..services import lifecycle
from ..services.runtime import is_system_enabled
from .auth import Principal, current_principal, require_admin
from .serializers import serialize_movie, serialize_season

router = APIRouter(prefix="/api/v1", tags=["schedule"])


async def _collect(session: AsyncSession, states: list[str]):
    out = []
    movies = (
        (
            await session.execute(
                select(MediaItem).where(
                    MediaItem.type == "movie", MediaItem.state.in_(states)
                )
            )
        )
        .scalars()
        .all()
    )
    for m in movies:
        out.append(await serialize_movie(session, m))
    rows = (
        await session.execute(
            select(Season, MediaItem)
            .join(MediaItem, Season.media_item_id == MediaItem.id)
            .where(Season.state.in_(states))
        )
    ).all()
    for s, item in rows:
        out.append(await serialize_season(session, item, s))
    return out


@router.get("/schedule")
async def schedule(
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
):
    states = [
        LifecycleState.SCHEDULED.value,
        LifecycleState.DELETING.value,
        LifecycleState.ERROR.value,
    ]
    units = await _collect(session, states)
    units.sort(
        key=lambda u: (
            u["state"] != "ERROR",
            u["days_until"] if u["days_until"] is not None else 1e9,
        )
    )
    return {
        "units": units,
        "scheduled_count": len([u for u in units if u["state"] == "SCHEDULED"]),
        "total_gb": round(
            sum(u["size_gb"] for u in units if u["state"] == "SCHEDULED"), 1
        ),
        "system_enabled": await is_system_enabled(session),
    }


async def _get_unit_or_404(session, unit_type, unit_id):
    unit = await lifecycle.get_unit(session, unit_type, unit_id)
    if unit is None:
        raise HTTPException(404, "Unit not found")
    return unit


@router.post("/units/{unit_type}/{unit_id}/keep")
async def keep(
    unit_type: str,
    unit_id: int,
    body: KeepIn,
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(current_principal),
):
    unit = await _get_unit_or_404(session, unit_type, unit_id)
    days = body.days
    if not principal.is_admin:
        days = days or 30
    await lifecycle.keep_unit(
        session, unit, days=days, actor=principal.name, reason=body.reason
    )
    return {"ok": True, "state": unit.obj.state}


@router.post("/units/{unit_type}/{unit_id}/schedule")
async def schedule_unit(
    unit_type: str,
    unit_id: int,
    days: int = 30,
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_admin),
):
    unit = await _get_unit_or_404(session, unit_type, unit_id)
    await lifecycle.schedule_unit(session, unit, days=days, actor=principal.name)
    return {"ok": True}


@router.post("/units/{unit_type}/{unit_id}/unschedule")
async def unschedule_unit(
    unit_type: str,
    unit_id: int,
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_admin),
):
    unit = await _get_unit_or_404(session, unit_type, unit_id)
    await lifecycle.unschedule_unit(session, unit, actor=principal.name)
    return {"ok": True}


@router.post("/units/{unit_type}/{unit_id}/postpone")
async def postpone_unit(
    unit_type: str,
    unit_id: int,
    body: PostponeIn,
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_admin),
):
    unit = await _get_unit_or_404(session, unit_type, unit_id)
    await lifecycle.postpone_unit(session, unit, days=body.days, actor=principal.name)
    return {"ok": True}


@router.post("/units/{unit_type}/{unit_id}/delete-now")
async def delete_now(
    unit_type: str,
    unit_id: int,
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_admin),
):
    unit = await _get_unit_or_404(session, unit_type, unit_id)
    await lifecycle.schedule_unit(session, unit, days=0, actor=principal.name)
    result = await lifecycle.run_execute_deletions(session, force=True)
    return {"ok": True, "result": result}
