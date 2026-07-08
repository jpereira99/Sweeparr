"""Keep requests: user submit + admin approval queue + deep-link token (§8, §13)."""

from __future__ import annotations

import secrets
from datetime import timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import KeepRequest, LifecycleState, Season, User, utcnow
from ..schemas import DelayIn, KeepDecision, KeepIn
from ..services import lifecycle
from ..services.deeplink import read_unit_token
from ..services.events import publish
from ..services.runtime import all_settings
from .auth import Principal, current_principal, require_admin
from .serializers import _public_reason

router = APIRouter(prefix="/api/v1", tags=["keep"])


def _iso(dt):
    return dt.replace(tzinfo=timezone.utc).isoformat() if dt else None


async def _action_options(
    session: AsyncSession, unit: lifecycle.Unit | None
) -> dict:
    """Which user actions (keep / delay) the client should offer for this unit."""
    settings = await all_settings(session)
    keep_enabled = bool(settings.get("keep_requests_enabled"))
    delay_enabled = bool(settings.get("delay_enabled"))
    delay_days = int(settings.get("delay_days") or 0)
    max_count = int(settings.get("delay_max_count") or 0)

    delay_count = 0
    delay_until = None
    scheduled = False
    if unit is not None:
        delay_count = getattr(unit.obj, "delay_count", 0) or 0
        delay_until = _iso(getattr(unit.obj, "delay_until", None))
        scheduled = unit.obj.state == LifecycleState.SCHEDULED.value
    delay_remaining = max(0, max_count - delay_count)

    return {
        "allow_keep": keep_enabled,
        "allow_delay": delay_enabled and scheduled and delay_remaining > 0,
        "delay_days": delay_days,
        "delay_count": delay_count,
        "delay_remaining": delay_remaining,
        "delay_until": delay_until,
    }


async def _serialize_kr(session: AsyncSession, kr: KeepRequest) -> dict:
    user = await session.get(User, kr.user_id) if kr.user_id else None
    unit = await lifecycle.get_unit(session, kr.unit_type, kr.unit_id)
    title = unit.item.title if unit else "?"
    season_number = (
        getattr(unit.obj, "season_number", None)
        if unit and kr.unit_type == "season"
        else None
    )
    delete_at = _iso(unit.obj.delete_at) if unit else None
    days_until = None
    if unit and unit.obj.delete_at:
        da = unit.obj.delete_at
        da = da if da.tzinfo else da.replace(tzinfo=timezone.utc)
        days_until = round((da - utcnow()).total_seconds() / 86400.0, 1)
    size_gb = round(unit.size_bytes / 1e9, 1) if unit else None
    reason_public = (
        _public_reason(getattr(unit.obj, "match_snapshot", None))
        if unit
        else "Matched a removal rule"
    )
    return {
        "id": kr.id,
        "unit_type": kr.unit_type,
        "unit_id": kr.unit_id,
        "title": title,
        "season_number": season_number,
        "requester": user.name if user else None,
        "reason": kr.reason,
        "status": kr.status,
        "created_at": _iso(kr.created_at),
        "delete_at": delete_at,
        "days_until": days_until,
        "token": kr.token,
        "size_gb": size_gb,
        "reason_public": reason_public,
        **await _action_options(session, unit),
    }


async def _serialize_unit_flag(
    session: AsyncSession, unit: lifecycle.Unit, token: str
) -> dict:
    season_number = (
        getattr(unit.obj, "season_number", None) if unit.type == "season" else None
    )
    delete_at = _iso(unit.obj.delete_at)
    days_until = None
    if unit.obj.delete_at:
        da = unit.obj.delete_at
        da = da if da.tzinfo else da.replace(tzinfo=timezone.utc)
        days_until = round((da - utcnow()).total_seconds() / 86400.0, 1)
    return {
        "id": None,
        "unit_type": unit.type,
        "unit_id": unit.id,
        "title": unit.item.title,
        "season_number": season_number,
        "requester": None,
        "reason": None,
        "status": "pending",
        "created_at": None,
        "delete_at": delete_at,
        "days_until": days_until,
        "token": token,
        "size_gb": round(unit.size_bytes / 1e9, 1),
        "reason_public": _public_reason(getattr(unit.obj, "match_snapshot", None)),
        **await _action_options(session, unit),
    }


@router.get("/keep-requests")
async def list_keep_requests(
    status: str = "pending",
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
):
    stmt = select(KeepRequest).order_by(KeepRequest.created_at.desc())
    if status != "all":
        stmt = stmt.where(KeepRequest.status == status)
    krs = (await session.execute(stmt)).scalars().all()
    return {"keep_requests": [await _serialize_kr(session, k) for k in krs]}


@router.get("/my-keep-requests")
async def my_keep_requests(
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(current_principal),
):
    stmt = (
        select(KeepRequest)
        .where(KeepRequest.user_id == principal.user_id)
        .order_by(KeepRequest.created_at.desc())
    )
    krs = (await session.execute(stmt)).scalars().all()
    return {"keep_requests": [await _serialize_kr(session, k) for k in krs]}


@router.post("/units/{unit_type}/{unit_id}/keep-request")
async def create_keep_request(
    unit_type: str,
    unit_id: int,
    body: KeepIn,
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(current_principal),
):
    settings = await all_settings(session)
    if not settings.get("keep_requests_enabled"):
        raise HTTPException(403, "Keep requests are disabled")
    unit = await lifecycle.get_unit(session, unit_type, unit_id)
    if unit is None:
        raise HTTPException(404, "Unit not found")
    existing = (
        (
            await session.execute(
                select(KeepRequest).where(
                    KeepRequest.unit_type == unit_type,
                    KeepRequest.unit_id == unit_id,
                    KeepRequest.status == "pending",
                )
            )
        )
        .scalars()
        .first()
    )
    if existing:
        return {"existing": True, **await _serialize_kr(session, existing)}
    kr = KeepRequest(
        unit_type=unit_type,
        unit_id=unit_id,
        user_id=principal.user_id,
        reason=body.reason,
        status="pending",
        token=secrets.token_urlsafe(12),
    )
    session.add(kr)
    await session.commit()
    publish("keep_request_created", {"unit": unit.key})
    return await _serialize_kr(session, kr)


@router.post("/keep-requests/{kr_id}/approve")
async def approve(
    kr_id: int,
    body: KeepDecision,
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_admin),
):
    kr = await session.get(KeepRequest, kr_id)
    if not kr:
        raise HTTPException(404, "Not found")
    kr.status = "approved"
    kr.decided_by = principal.user_id
    kr.decided_at = utcnow()
    kr.expires_at = (utcnow() + timedelta(days=body.days)) if body.days else None
    unit = await lifecycle.get_unit(session, kr.unit_type, kr.unit_id)
    if unit:
        await lifecycle.keep_unit(
            session,
            unit,
            days=body.days,
            actor=principal.name,
            reason=f"keep approved: {kr.reason or ''}",
        )
    await session.commit()
    return {"ok": True}


@router.post("/keep-requests/{kr_id}/deny")
async def deny(
    kr_id: int,
    body: KeepDecision,
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_admin),
):
    kr = await session.get(KeepRequest, kr_id)
    if not kr:
        raise HTTPException(404, "Not found")
    if not body.reason:
        raise HTTPException(400, "A reason is required to deny")
    kr.status = "denied"
    kr.decided_by = principal.user_id
    kr.decided_at = utcnow()
    kr.decision_reason = body.reason
    await session.commit()
    return {"ok": True}


async def _resolve_keep_token(session: AsyncSession, token: str) -> dict:
    """Resolve a keep deep-link token to serialized payload or raise 404."""
    kr = (
        (await session.execute(select(KeepRequest).where(KeepRequest.token == token)))
        .scalars()
        .first()
    )
    if kr:
        return {"kind": "existing", **await _serialize_kr(session, kr)}

    ref = read_unit_token(token)
    if ref:
        unit_type, unit_id = ref
        unit = await lifecycle.get_unit(session, unit_type, unit_id)
        if unit and unit.obj.state == LifecycleState.SCHEDULED.value:
            existing = (
                (
                    await session.execute(
                        select(KeepRequest)
                        .where(
                            KeepRequest.unit_type == unit_type,
                            KeepRequest.unit_id == unit_id,
                        )
                        .order_by(KeepRequest.created_at.desc())
                    )
                )
                .scalars()
                .first()
            )
            if existing:
                return {"kind": "existing", **await _serialize_kr(session, existing)}
            return {"kind": "new", **await _serialize_unit_flag(session, unit, token)}

    raise HTTPException(404, "Unknown keep token")


@router.get("/keep/{token}")
async def keep_by_token(token: str, session: AsyncSession = Depends(get_session)):
    """Public-ish deep-link resolution for the Jellyfin banner (§8.2).

    Two token shapes land here: the ``secrets.token_urlsafe`` id stored on a
    KeepRequest once one exists, and the stateless per-unit token minted by
    /flags before any request has been filed (see services/deeplink.py).
    """
    return await _resolve_keep_token(session, token)


@router.post("/keep/{token}")
async def submit_keep_by_token(
    token: str,
    body: KeepIn,
    session: AsyncSession = Depends(get_session),
):
    """Token-authenticated keep submission for the Jellyfin inject modal.

    The signed deep-link token is the capability — no Sweeparr session required.
    """
    settings = await all_settings(session)
    if not settings.get("keep_requests_enabled"):
        raise HTTPException(403, "Keep requests are disabled")
    data = await _resolve_keep_token(session, token)
    if data.get("status") != "pending" or data.get("id") is not None:
        return {"existing": True, **data}

    unit = await lifecycle.get_unit(session, data["unit_type"], data["unit_id"])
    if unit is None:
        raise HTTPException(404, "Unit not found")

    kr = KeepRequest(
        unit_type=data["unit_type"],
        unit_id=data["unit_id"],
        user_id=None,
        reason=body.reason,
        status="pending",
        token=secrets.token_urlsafe(12),
    )
    session.add(kr)
    await session.commit()
    publish("keep_request_created", {"unit": unit.key})
    return {"existing": False, **await _serialize_kr(session, kr)}


async def _unit_from_keep_token(session: AsyncSession, token: str) -> lifecycle.Unit:
    """Resolve a signed unit token or an existing KeepRequest token to its unit."""
    ref = read_unit_token(token)
    if ref is None:
        kr = (
            (
                await session.execute(
                    select(KeepRequest).where(KeepRequest.token == token)
                )
            )
            .scalars()
            .first()
        )
        if kr is not None:
            ref = (kr.unit_type, kr.unit_id)
    if ref is None:
        raise HTTPException(404, "Unknown keep token")
    unit = await lifecycle.get_unit(session, ref[0], ref[1])
    if unit is None:
        raise HTTPException(404, "Unit not found")
    return unit


@router.post("/delay/{token}")
async def delay_by_token(
    token: str,
    body: DelayIn,
    session: AsyncSession = Depends(get_session),
):
    """Automatic, token-authenticated self-service delay for the Jellyfin banner.

    No admin approval and no keep-request row: it simply pushes the scheduled
    deletion date out by the admin-configured number of days, capped per item.
    """
    settings = await all_settings(session)
    if not settings.get("delay_enabled"):
        raise HTTPException(403, "Delays are disabled")

    unit = await _unit_from_keep_token(session, token)
    if unit.obj.state != LifecycleState.SCHEDULED.value:
        raise HTTPException(409, "This item is no longer scheduled for removal")

    result = await lifecycle.delay_unit(
        session,
        unit,
        days=int(settings.get("delay_days") or 0),
        max_count=int(settings.get("delay_max_count") or 0),
        actor="jellyfin user",
        reason=body.reason,
    )
    if not result.get("ok") and result.get("reason") == "capped":
        return {"ok": False, "capped": True, **await _resolve_keep_token(session, token)}
    if not result.get("ok"):
        raise HTTPException(409, "This item can no longer be delayed")
    return {"ok": True, **result, **await _resolve_keep_token(session, token)}
