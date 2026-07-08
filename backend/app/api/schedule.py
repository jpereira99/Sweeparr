"""Schedule feed (Upcoming Removals) + per-unit lifecycle actions (§12)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import LifecycleState, MediaItem, Protection, Season
from ..schemas import KeepIn, RestoreIn
from ..services import lifecycle
from ..services.runtime import all_settings, is_system_enabled
from .auth import Principal, require_admin
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


@router.get("/kept")
async def kept(
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
):
    """All currently KEPT units (flagged keeps), with the full, live list of
    protections behind each one — an admin keep, or one or more system
    protections (favorite, airing, tag, request window, unmanaged).
    """
    units = await _collect(session, [LifecycleState.KEPT.value])
    rows = (await session.execute(select(Protection))).scalars().all()
    by_key: dict[str, list[dict]] = {}
    for r in rows:
        by_key.setdefault(f"{r.unit_type}:{r.unit_id}", []).append(
            {"kind": r.kind, "detail": r.detail}
        )
    for u in units:
        protections = by_key.get(u["key"], [])
        u["protections"] = protections
        u["keep_reason"] = next(
            (p["detail"] for p in protections if p["kind"] == "keep"), None
        )
        u["auto_liftable"] = bool(protections) and not any(
            p["kind"] == "keep" for p in protections
        )
    units.sort(key=lambda u: u["title"].lower())
    return {"units": units, "total_gb": round(sum(u["size_gb"] for u in units), 1)}


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
    principal: Principal = Depends(require_admin),
):
    unit = await _get_unit_or_404(session, unit_type, unit_id)
    await lifecycle.keep_unit(
        session, unit, actor=principal.name, reason=body.reason
    )
    return {"ok": True, "state": unit.obj.state}


@router.post("/units/{unit_type}/{unit_id}/release")
async def release(
    unit_type: str,
    unit_id: int,
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_admin),
):
    unit = await _get_unit_or_404(session, unit_type, unit_id)
    await lifecycle.release_unit(session, unit, actor=principal.name)
    return {"ok": True, "state": unit.obj.state}


@router.post("/units/{unit_type}/{unit_id}/restore")
async def restore(
    unit_type: str,
    unit_id: int,
    body: RestoreIn,
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_admin),
):
    """Undo a keep/delay by replaying the unit's prior lifecycle snapshot."""
    unit = await _get_unit_or_404(session, unit_type, unit_id)
    await lifecycle.restore_unit(
        session,
        unit,
        state=body.state,
        delete_at=body.delete_at,
        delay_until=body.delay_until,
        delay_count=body.delay_count,
        matched_rule_id=body.matched_rule_id,
        actor=principal.name,
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


@router.post("/units/{unit_type}/{unit_id}/delay")
async def delay_unit(
    unit_type: str,
    unit_id: int,
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_admin),
):
    """Unified Delay: same capped, floor-setting mechanism as the user path.

    ``delay_enabled`` gates only the public token endpoint; admins can always
    delay using the configured ``delay_days`` / ``delay_max_count``.
    """
    unit = await _get_unit_or_404(session, unit_type, unit_id)
    settings = await all_settings(session)
    result = await lifecycle.delay_unit(
        session,
        unit,
        days=int(settings.get("delay_days") or 0),
        max_count=int(settings.get("delay_max_count") or 0),
        actor=principal.name,
    )
    if not result.get("ok"):
        if result.get("reason") == "capped":
            raise HTTPException(409, "Delay cap reached for this item")
        raise HTTPException(409, "This item is not scheduled for removal")
    return {"ok": True, **result}


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
