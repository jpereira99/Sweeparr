"""Shared response serialization for units and media rows."""

from __future__ import annotations

from datetime import timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import (
    ItemWatchFacts,
    LifecycleState,
    MediaItem,
    RuleSet,
    Season,
    SeasonWatchFacts,
    utcnow,
)

GB = 1024**3


def _iso(dt):
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _days_until(dt):
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (dt - utcnow()).total_seconds() / 86400.0


async def _rule_name(session: AsyncSession, rule_id):
    if not rule_id:
        return None
    r = await session.get(RuleSet, rule_id)
    return r.name if r else None


def _public_reason(snapshot: dict | None) -> str:
    if not snapshot:
        return "Matched a removal rule"
    if "last_watched_days" in snapshot:
        v = snapshot["last_watched_days"].get("value")
        if v == "never":
            return "Never watched"
        return (
            f"Not watched in {int(v)}+ days"
            if isinstance(v, (int, float))
            else "Not watched recently"
        )
    if "requester_inactive_days" in snapshot:
        return "Requester inactive"
    return "Matched a removal rule"


async def serialize_movie(session: AsyncSession, item: MediaItem) -> dict[str, Any]:
    facts = await session.get(ItemWatchFacts, item.id)
    return {
        "key": f"movie:{item.id}",
        "unit_type": "movie",
        "unit_id": item.id,
        "media_item_id": item.id,
        "title": item.title,
        "year": item.year,
        "type": "movie",
        "library": item.library,
        "size_gb": round((item.size_bytes or 0) / GB, 1),
        "state": item.state,
        "delete_at": _iso(item.delete_at),
        "days_until": _days_until(item.delete_at),
        "rule_id": item.matched_rule_id,
        "rule_name": await _rule_name(session, item.matched_rule_id),
        "snapshot": item.match_snapshot,
        "reason_public": _public_reason(item.match_snapshot),
        "unmanaged": item.unmanaged,
        "quality": item.quality,
        "resolution": item.resolution,
        "last_watched_days": _last_watched_days(facts),
        "total_plays": facts.total_plays if facts else 0,
        "distinct_watchers": facts.distinct_watchers if facts else 0,
        "max_completion_pct": facts.max_completion_pct if facts else 0,
        "jellyfin_id": item.jellyfin_id,
    }


async def serialize_season(
    session: AsyncSession, item: MediaItem, season: Season
) -> dict[str, Any]:
    sf = await session.get(SeasonWatchFacts, season.id)
    return {
        "key": f"season:{season.id}",
        "unit_type": "season",
        "unit_id": season.id,
        "media_item_id": item.id,
        "title": item.title,
        "season_number": season.season_number,
        "type": "series",
        "library": item.library,
        "size_gb": round((season.size_bytes or 0) / GB, 1),
        "episode_count": season.episode_count,
        "state": season.state,
        "delete_at": _iso(season.delete_at),
        "days_until": _days_until(season.delete_at),
        "rule_id": season.matched_rule_id,
        "rule_name": await _rule_name(session, season.matched_rule_id),
        "snapshot": season.match_snapshot,
        "reason_public": _public_reason(season.match_snapshot),
        "is_latest_season": season.is_latest_season,
        "series_status": item.series_status,
        "unmanaged": item.unmanaged,
        "last_watched_days": _last_watched_days(sf),
        "pct_season_watched": sf.pct_season_watched if sf else 0,
        "total_plays": sf.total_plays if sf else 0,
        "distinct_watchers": sf.distinct_watchers if sf else 0,
        "jellyfin_id": item.jellyfin_id,
    }


def _last_watched_days(facts):
    if facts is None or facts.last_watched_at is None:
        return None
    dt = facts.last_watched_at
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int((utcnow() - dt).total_seconds() / 86400.0)
