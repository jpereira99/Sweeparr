"""Build the per-unit ``facts`` dict the rule engine consumes (§5, §6).

Facts are assembled from local DB rows only — no live API calls — so rule
evaluation stays pure, fast and deterministic.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import (
    ArrTag,
    ItemWatchFacts,
    MediaItem,
    Request,
    Season,
    SeasonWatchFacts,
    User,
    utcnow,
)

GB = 1024 ** 3


def _days_since(dt: Optional[datetime]) -> Optional[float]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (utcnow() - dt).total_seconds() / 86400.0


async def _tags(session: AsyncSession, item_id: int) -> list[str]:
    rows = (await session.execute(select(ArrTag.tag).where(ArrTag.media_item_id == item_id))).scalars().all()
    return list(rows)


async def _request_facts(session: AsyncSession, item_id: int) -> dict[str, Any]:
    req = (
        await session.execute(
            select(Request).where(Request.media_item_id == item_id).order_by(Request.requested_at.desc())
        )
    ).scalars().first()
    if req is None:
        return {"was_requested": False, "requested_days_ago": None, "requester_inactive_days": None}
    inactive = None
    if req.requester_user_id is not None:
        user = await session.get(User, req.requester_user_id)
        if user is not None:
            inactive = _days_since(user.last_active_at)
    return {
        "was_requested": True,
        "requested_days_ago": _days_since(req.requested_at),
        "requester_inactive_days": inactive,
    }


async def build_movie_facts(
    session: AsyncSession, item: MediaItem, disk_pct: float = 0.0
) -> dict[str, Any]:
    facts = await session.get(ItemWatchFacts, item.id)
    reqf = await _request_facts(session, item.id)
    year_age = None
    if item.year:
        year_age = (utcnow().year - item.year) * 365.25
    return {
        "media_type": "movie",
        "age_days": _days_since(item.date_added_arr),
        "release_age_days": year_age,
        "last_watched_days": _days_since(facts.last_watched_at) if facts else None,
        "total_plays": facts.total_plays if facts else 0,
        "distinct_watchers": facts.distinct_watchers if facts else 0,
        "max_completion_pct": facts.max_completion_pct if facts else 0.0,
        "watched_by_requester": facts.watched_by_requester if facts else False,
        "is_favorite_any_user": facts.is_favorite_any_user if facts else False,
        "size_gb": (item.size_bytes or 0) / GB,
        "quality": item.quality,
        "video_resolution": item.resolution,
        "has_tag": await _tags(session, item.id),
        "not_has_tag": await _tags(session, item.id),
        "disk_usage_pct": disk_pct,
        "library": item.library,
        **reqf,
    }


async def build_season_facts(
    session: AsyncSession, item: MediaItem, season: Season, disk_pct: float = 0.0
) -> dict[str, Any]:
    sfacts = await session.get(SeasonWatchFacts, season.id)
    item_facts = await session.get(ItemWatchFacts, item.id)
    reqf = await _request_facts(session, item.id)
    return {
        "media_type": "season",
        "season_number": season.season_number,
        "is_latest_season": season.is_latest_season,
        "season_age_days": _days_since(season.newest_file_date),
        "age_days": _days_since(season.newest_file_date),
        "season_last_watched_days": _days_since(sfacts.last_watched_at) if sfacts else None,
        "last_watched_days": _days_since(sfacts.last_watched_at) if sfacts else None,
        "pct_season_watched": sfacts.pct_season_watched if sfacts else 0.0,
        "season_size_gb": (season.size_bytes or 0) / GB,
        "total_plays": sfacts.total_plays if sfacts else 0,
        "distinct_watchers": sfacts.distinct_watchers if sfacts else 0,
        "watched_by_requester": sfacts.watched_by_requester if sfacts else False,
        "series_status": item.series_status,
        "pct_episodes_watched": item_facts.pct_episodes_watched if item_facts else 0.0,
        "has_tag": await _tags(session, item.id),
        "not_has_tag": await _tags(session, item.id),
        "disk_usage_pct": disk_pct,
        "library": item.library,
        **reqf,
    }
