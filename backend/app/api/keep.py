"""Keep requests: user submit + admin approval queue + deep-link token (§8, §13)."""

from __future__ import annotations

import secrets
from datetime import timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import KeepRequest, Season, User, utcnow
from ..schemas import KeepDecision, KeepIn
from ..services import lifecycle
from ..services.events import publish
from .auth import Principal, current_principal, require_admin
from .serializers import _public_reason

router = APIRouter(prefix="/api/v1", tags=["keep"])


def _iso(dt):
    return dt.replace(tzinfo=timezone.utc).isoformat() if dt else None


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


@router.get("/keep/{token}")
async def keep_by_token(token: str, session: AsyncSession = Depends(get_session)):
    """Public-ish deep-link resolution for the Jellyfin banner (§8.2)."""
    kr = (
        (await session.execute(select(KeepRequest).where(KeepRequest.token == token)))
        .scalars()
        .first()
    )
    if kr:
        return {"kind": "existing", **await _serialize_kr(session, kr)}
    raise HTTPException(404, "Unknown keep token")
