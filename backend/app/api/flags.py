"""Public, cached, CORS-enabled /flags endpoint for the Jellyfin inject script
(§8.2). Returns only non-sensitive fields and never requires auth. Fails safe
(empty) rather than leaking anything."""

from __future__ import annotations

from datetime import timezone

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..services.integrations import get_integrations
from ..db import get_session
from ..models import LifecycleState, MediaItem, Season
from .serializers import _public_reason

router = APIRouter(tags=["public"])


@router.get("/flags")
async def flags(
    response: Response,
    jellyfin_ids: str = Query(""),
    session: AsyncSession = Depends(get_session),
):
    response.headers["Cache-Control"] = "public, max-age=300"
    response.headers["Access-Control-Allow-Origin"] = "*"
    ids = [x.strip() for x in jellyfin_ids.split(",") if x.strip()]
    if not ids:
        return {"items": []}

    base = get_integrations().jellyseerr.base_url or ""
    items = []
    movies = (
        (
            await session.execute(
                select(MediaItem).where(
                    MediaItem.jellyfin_id.in_(ids),
                    MediaItem.state == LifecycleState.SCHEDULED.value,
                )
            )
        )
        .scalars()
        .all()
    )
    for m in movies:
        items.append(_flag(m.jellyfin_id, m.delete_at, m.match_snapshot))

    rows = (
        await session.execute(
            select(Season, MediaItem)
            .join(MediaItem, Season.media_item_id == MediaItem.id)
            .where(
                MediaItem.jellyfin_id.in_(ids),
                Season.state == LifecycleState.SCHEDULED.value,
            )
        )
    ).all()
    for s, item in rows:
        items.append(
            _flag(
                item.jellyfin_id, s.delete_at, s.match_snapshot, season=s.season_number
            )
        )
    return {"items": items}


def _flag(jf_id, delete_at, snapshot, season=None):
    da = None
    if delete_at:
        da = (
            (delete_at if delete_at.tzinfo else delete_at.replace(tzinfo=timezone.utc))
            .date()
            .isoformat()
        )
    return {
        "jellyfin_id": jf_id,
        "season_number": season,
        "delete_at": da,
        "reason_public": _public_reason(snapshot),
    }
