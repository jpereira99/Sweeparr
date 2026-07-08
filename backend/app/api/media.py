"""Media explorer + item detail drawer (§12, §13)."""

from __future__ import annotations

from datetime import timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..db import get_session
from ..models import (
    AuditLog,
    ItemWatchFacts,
    MediaItem,
    Protection,
    Request,
    Season,
    User,
    utcnow,
)
from ..services import lifecycle
from ..services.integrations import get_integrations
from .auth import Principal, require_admin
from .serializers import (
    _last_watched_days,
    _poster_url,
    serialize_movie,
    serialize_season,
)

router = APIRouter(prefix="/api/v1", tags=["media"])

GB = 1024**3


@router.get("/media")
async def list_media(
    type: Optional[str] = None,
    library: Optional[str] = None,
    state: Optional[str] = None,
    sort: str = "gb_per_hour",
    order: str = "desc",
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
):
    stmt = (
        select(MediaItem)
        .where(MediaItem.deleted_externally == False)
        .options(selectinload(MediaItem.seasons))  # noqa: E712
    )
    if type:
        stmt = stmt.where(MediaItem.type == type)
    if library:
        stmt = stmt.where(MediaItem.library == library)
    items = (await session.execute(stmt)).scalars().all()

    rows = []
    for it in items:
        facts = await session.get(ItemWatchFacts, it.id)
        watched_hours = 0.0
        if facts and facts.total_plays and it.runtime_minutes:
            watched_hours = (
                facts.total_plays
                * (it.runtime_minutes / 60.0)
                * (facts.max_completion_pct / 100.0 or 1)
            )
        size_gb = round((it.size_bytes or 0) / GB, 1)
        gb_per_hour = (size_gb / watched_hours) if watched_hours > 0 else None
        seasons = []
        if it.type == "series":
            for s in sorted(it.seasons, key=lambda x: x.season_number):
                seasons.append(
                    {
                        "season_number": s.season_number,
                        "state": s.state,
                        "size_gb": round((s.size_bytes or 0) / GB, 1),
                        "delay_count": s.delay_count or 0,
                    }
                )
        rows.append(
            {
                "media_item_id": it.id,
                "title": it.title,
                "poster_url": _poster_url(it),
                "type": it.type,
                "year": it.year,
                "library": it.library,
                "size_gb": size_gb,
                "state": it.state,
                "delay_count": it.delay_count or 0,
                "last_watched_days": _last_watched_days(facts),
                "total_plays": facts.total_plays if facts else 0,
                "distinct_watchers": facts.distinct_watchers if facts else 0,
                "max_completion_pct": facts.max_completion_pct if facts else 0,
                "gb_per_hour": (
                    round(gb_per_hour, 1) if gb_per_hour is not None else None
                ),
                "unmanaged": it.unmanaged,
                "seasons": seasons,
            }
        )

    def sort_value(r):
        if sort == "gb_per_hour":
            v = r["gb_per_hour"]
            return (v is None, -(v or 0))
        if sort == "size":
            return (False, -r["size_gb"])
        if sort == "last_watched":
            v = r["last_watched_days"]
            return (v is None, -(v or 0))
        if sort == "total_plays":
            return (False, -r["total_plays"])
        if sort == "distinct_watchers":
            return (False, -r["distinct_watchers"])
        if sort == "completion":
            return (False, -r["max_completion_pct"])
        if sort == "type":
            return (False, r["type"])
        return (False, r["title"].lower())

    rows.sort(key=sort_value, reverse=(order == "asc"))
    return {"items": rows}


@router.get("/media/{item_id}")
async def media_detail(
    item_id: int,
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
):
    it = (
        (
            await session.execute(
                select(MediaItem)
                .where(MediaItem.id == item_id)
                .options(selectinload(MediaItem.seasons))
            )
        )
        .scalars()
        .first()
    )
    if not it:
        raise HTTPException(404, "Not found")

    season_number_by_unit_id: dict[int, int] = {}
    if it.type == "movie":
        base = await serialize_movie(session, it)
        units = [lifecycle.Unit("movie", it, it)]
    else:
        # Series-wide aggregate (the default "all seasons" overview); each
        # season also carries its own stats for when one is selected.
        facts = await session.get(ItemWatchFacts, it.id)
        base = {
            "media_item_id": it.id,
            "title": it.title,
            "poster_url": _poster_url(it),
            "type": "series",
            "series_status": it.series_status,
            "size_gb": round((it.size_bytes or 0) / GB, 1),
            "last_watched_days": _last_watched_days(facts),
            "total_plays": facts.total_plays if facts else 0,
            "distinct_watchers": facts.distinct_watchers if facts else 0,
        }
        base["seasons"] = [
            await serialize_season(session, it, s)
            for s in sorted(it.seasons, key=lambda x: x.season_number)
        ]
        units = [lifecycle.Unit("season", s, it) for s in it.seasons]
        season_number_by_unit_id = {s.id: s.season_number for s in it.seasons}

    # Protections across the item's units, tagged with the owning season so
    # the drawer can filter down to one season instead of always showing
    # the whole-series overview.
    protections = []
    for u in units:
        for p in await lifecycle.protection_reasons(session, u):
            protections.append(
                {
                    **p,
                    "unit_type": u.type,
                    "unit_id": u.id,
                    "season_number": season_number_by_unit_id.get(u.id),
                }
            )

    reqs = (
        (await session.execute(select(Request).where(Request.media_item_id == item_id)))
        .scalars()
        .all()
    )
    requests = []
    for r in reqs:
        user = (
            await session.get(User, r.requester_user_id)
            if r.requester_user_id
            else None
        )
        requests.append(
            {
                "requester": user.name if user else None,
                "requested_at": (
                    r.requested_at.replace(tzinfo=timezone.utc).isoformat()
                    if r.requested_at
                    else None
                ),
                "season_number": r.season_number,
                "status": r.status,
            }
        )

    history = (
        (
            await session.execute(
                select(AuditLog)
                .where(AuditLog.media_item_id == item_id)
                .order_by(AuditLog.ts.desc())
                .limit(30)
            )
        )
        .scalars()
        .all()
    )
    audit = [
        {
            "ts": h.ts.replace(tzinfo=timezone.utc).isoformat(),
            "action": h.action,
            "actor": h.actor,
            "unit_type": h.unit_type,
            "unit_id": h.unit_id,
            "season_number": season_number_by_unit_id.get(h.unit_id),
            "detail": h.detail,
        }
        for h in history
    ]

    return {**base, "protections": protections, "requests": requests, "history": audit}


@router.get("/media/{item_id}/poster")
async def media_poster(
    item_id: int,
    max_width: int = Query(400, ge=32, le=1200),
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
):
    """Proxy an item's poster from Jellyfin so the browser needs no JF creds."""
    it = await session.get(MediaItem, item_id)
    if not it or not it.jellyfin_id:
        raise HTTPException(404, "No poster available")
    result = await get_integrations().jellyfin.get_primary_image(
        it.jellyfin_id, max_width=max_width
    )
    if result is None:
        raise HTTPException(404, "No poster available")
    content, content_type = result
    return Response(
        content=content,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )
