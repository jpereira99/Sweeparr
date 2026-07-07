"""Library / request / playback sync jobs (§5).

Upsert + tombstone: items that vanish from a service get ``deleted_externally``
rather than a row delete, so history/stats survive. Adapters degrade gracefully
— an unconfigured or unreachable service skips rather than crashing the job.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import (
    ItemWatchFacts,
    MediaItem,
    PlaybackSession,
    Season,
    SeasonWatchFacts,
    utcnow,
)
from .integrations import get_integrations
from .runtime import set_setting

GB = 1024**3
TB = 1024**4


def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


async def _match_by_ids(
    session: AsyncSession, *, tmdb=None, tvdb=None, imdb=None
) -> Optional[MediaItem]:
    """Identity join in priority order (§4): provider IDs, then IMDB."""
    for col, val in (
        (MediaItem.tmdb_id, tmdb),
        (MediaItem.tvdb_id, tvdb),
        (MediaItem.imdb_id, imdb),
    ):
        if val:
            row = (
                (await session.execute(select(MediaItem).where(col == val)))
                .scalars()
                .first()
            )
            if row:
                return row
    return None


async def sync_disk_space(session: AsyncSession) -> dict[str, Any]:
    """Pull root-folder usage from Sonarr/Radarr diskspace APIs into settings."""
    disk: dict[str, float] = {}
    capacity_tb: dict[str, float] = {}
    integ = get_integrations()

    for adapter in (integ.radarr, integ.sonarr):
        if not adapter.configured:
            continue
        try:
            spaces = await adapter.get_diskspace()
        except Exception:  # noqa: BLE001
            continue
        for entry in spaces or []:
            path = entry.get("path")
            total = entry.get("totalSpace") or 0
            free = entry.get("freeSpace") or 0
            if not path or not total:
                continue
            disk[path] = round((1 - free / total) * 100, 1)
            capacity_tb[path] = round(total / TB, 2)

    if not disk:
        return {"skipped": "no diskspace data"}
    await set_setting(session, "disk", disk)
    await set_setting(session, "disk_capacity_tb", capacity_tb)
    await session.commit()
    return {"roots": len(disk)}


async def sync_radarr(session: AsyncSession) -> dict[str, Any]:
    radarr = get_integrations().radarr
    if not radarr.configured:
        return {"skipped": "not configured"}
    try:
        movies = await radarr.get_movies()
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}
    upserted = 0
    for m in movies:
        item = await _match_by_ids(session, tmdb=m.get("tmdbId"), imdb=m.get("imdbId"))
        if item is None:
            item = MediaItem(type="movie")
            session.add(item)
        item.title = m.get("title", item.title or "Untitled")
        item.year = m.get("year")
        item.tmdb_id = m.get("tmdbId")
        item.imdb_id = m.get("imdbId")
        item.radarr_id = m.get("id")
        item.monitored = m.get("monitored", True)
        item.path = m.get("path")
        item.root_folder = m.get("rootFolderPath")
        item.library = m.get("rootFolderPath")
        item.date_added_arr = _parse_dt(m.get("added"))
        mf = m.get("movieFile") or {}
        item.size_bytes = mf.get("size", 0) or m.get("sizeOnDisk", 0)
        item.quality = (mf.get("quality") or {}).get("quality", {}).get("name")
        item.deleted_externally = False
        upserted += 1
    disk = await sync_disk_space(session)
    await session.commit()
    return {"upserted": upserted, "disk": disk}


async def sync_sonarr(session: AsyncSession) -> dict[str, Any]:
    sonarr = get_integrations().sonarr
    if not sonarr.configured:
        return {"skipped": "not configured"}
    try:
        series_list = await sonarr.get_series()
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}
    upserted = 0
    for s in series_list:
        item = await _match_by_ids(session, tvdb=s.get("tvdbId"), imdb=s.get("imdbId"))
        if item is None:
            item = MediaItem(type="series")
            session.add(item)
        item.title = s.get("title", item.title or "Untitled")
        item.year = s.get("year")
        item.tvdb_id = s.get("tvdbId")
        item.sonarr_id = s.get("id")
        item.path = s.get("path")
        item.root_folder = s.get("rootFolderPath")
        item.library = s.get("rootFolderPath")
        item.series_status = s.get("status")
        item.monitored = s.get("monitored", True)
        item.date_added_arr = _parse_dt(s.get("added"))
        await session.flush()
        seasons = [x for x in s.get("seasons", []) if x.get("seasonNumber", 0) > 0]
        for idx, sea in enumerate(seasons):
            num = sea["seasonNumber"]
            existing = (
                (
                    await session.execute(
                        select(Season).where(
                            Season.media_item_id == item.id, Season.season_number == num
                        )
                    )
                )
                .scalars()
                .first()
            )
            if existing is None:
                existing = Season(media_item_id=item.id, season_number=num)
                session.add(existing)
            stats = sea.get("statistics", {})
            existing.monitored = sea.get("monitored", True)
            existing.size_bytes = stats.get("sizeOnDisk", 0)
            existing.episode_count = stats.get("episodeFileCount", 0)
            existing.is_latest_season = idx == len(seasons) - 1
        item.size_bytes = (s.get("statistics") or {}).get("sizeOnDisk", 0)
        upserted += 1
    disk = await sync_disk_space(session)
    await session.commit()
    return {"upserted": upserted, "disk": disk}


async def sync_jellyfin(session: AsyncSession) -> dict[str, Any]:
    jf = get_integrations().jellyfin
    if not jf.configured:
        return {"skipped": "not configured"}
    matched = 0
    try:
        async for it in jf.iter_library_items():
            provider = it.get("ProviderIds", {})
            tmdb = provider.get("Tmdb")
            tvdb = provider.get("Tvdb")
            media = await _match_by_ids(
                session,
                tmdb=int(tmdb) if tmdb else None,
                tvdb=int(tvdb) if tvdb else None,
                imdb=provider.get("Imdb"),
            )
            if media:
                media.jellyfin_id = it.get("Id")
                media.date_created_jf = _parse_dt(it.get("DateCreated"))
                if it.get("RunTimeTicks"):
                    media.runtime_minutes = int(it["RunTimeTicks"] / 10_000_000 / 60)
                matched += 1
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}
    await session.flush()
    watch = await _sync_jellyfin_watch_stats(session, jf)
    await session.commit()
    return {"matched": matched, **watch}


@dataclass
class _WatchAccum:
    play_count: int = 0
    watchers: set[str] = field(default_factory=set)
    last_watched: datetime | None = None
    max_completion: float = 0.0
    favorite: bool = False


def _completion_pct(ud: dict[str, Any], runtime_ticks: int | None) -> float:
    if ud.get("Played"):
        return 100.0
    rt = runtime_ticks or 0
    pos = int(ud.get("PlaybackPositionTicks") or 0)
    if rt > 0 and pos > 0:
        return min(100.0, pos / rt * 100.0)
    return 0.0


def _apply_userdata(
    acc: _WatchAccum, jf_user_id: str, ud: dict[str, Any], runtime_ticks: int | None
) -> None:
    plays = int(ud.get("PlayCount") or 0)
    pos = int(ud.get("PlaybackPositionTicks") or 0)
    if plays <= 0 and pos <= 0:
        return
    acc.play_count += plays
    acc.watchers.add(jf_user_id)
    if ud.get("IsFavorite"):
        acc.favorite = True
    played_at = _parse_dt(ud.get("LastPlayedDate"))
    if played_at and (acc.last_watched is None or played_at > _aware(acc.last_watched)):
        acc.last_watched = played_at
    pct = _completion_pct(ud, runtime_ticks)
    if pct > acc.max_completion:
        acc.max_completion = pct


async def _load_jellyfin_lookups(session: AsyncSession):
    media_rows = (
        (
            await session.execute(
                select(MediaItem).where(MediaItem.jellyfin_id.isnot(None))
            )
        )
        .scalars()
        .all()
    )
    by_jf_id = {m.jellyfin_id: m for m in media_rows if m.jellyfin_id}

    season_rows = (
        await session.execute(
            select(Season, MediaItem)
            .join(MediaItem, Season.media_item_id == MediaItem.id)
            .where(MediaItem.jellyfin_id.isnot(None))
        )
    ).all()
    season_by_key: dict[tuple[str, int], Season] = {}
    episode_totals: dict[int, int] = {}
    for season, media in season_rows:
        if media.jellyfin_id:
            season_by_key[(media.jellyfin_id, season.season_number)] = season
        episode_totals[media.id] = (
            episode_totals.get(media.id, 0) + season.episode_count
        )

    return by_jf_id, season_by_key, episode_totals


async def _sync_jellyfin_watch_stats(session: AsyncSession, jf) -> dict[str, Any]:
    """Pull per-user UserData from Jellyfin into item/season watch facts."""
    try:
        users = await jf.get_users()
    except Exception as exc:  # noqa: BLE001
        return {"watch_error": str(exc)}

    by_jf_id, season_by_key, episode_totals = await _load_jellyfin_lookups(session)
    if not by_jf_id:
        return {"watch_items": 0, "watch_seasons": 0}

    item_acc: dict[int, _WatchAccum] = {}
    season_acc: dict[int, _WatchAccum] = {}
    series_watched_eps: dict[int, set[str]] = {}
    season_watched_eps: dict[int, set[str]] = {}

    for user in users:
        jf_user_id = user.get("Id")
        if not jf_user_id:
            continue

        async for it in jf.iter_user_watch_items(jf_user_id, include_types="Movie"):
            media = by_jf_id.get(it.get("Id"))
            if not media:
                continue
            ud = it.get("UserData") or {}
            acc = item_acc.setdefault(media.id, _WatchAccum())
            _apply_userdata(acc, jf_user_id, ud, it.get("RunTimeTicks"))

        async for it in jf.iter_user_watch_items(jf_user_id, include_types="Episode"):
            series_jf_id = it.get("SeriesId")
            season_num = it.get("ParentIndexNumber")
            if not series_jf_id or season_num is None:
                continue
            media = by_jf_id.get(series_jf_id)
            season = season_by_key.get((series_jf_id, int(season_num)))
            if not media or not season:
                continue
            ud = it.get("UserData") or {}
            ep_id = it.get("Id")
            sacc = season_acc.setdefault(season.id, _WatchAccum())
            _apply_userdata(sacc, jf_user_id, ud, it.get("RunTimeTicks"))
            if ep_id and int(ud.get("PlayCount") or 0) > 0:
                season_watched_eps.setdefault(season.id, set()).add(ep_id)
                series_watched_eps.setdefault(media.id, set()).add(ep_id)

            # Series-level rollup mirrors season activity.
            iacc = item_acc.setdefault(media.id, _WatchAccum())
            _apply_userdata(iacc, jf_user_id, ud, it.get("RunTimeTicks"))

    for item_id, acc in item_acc.items():
        facts = await session.get(ItemWatchFacts, item_id)
        if facts is None:
            facts = ItemWatchFacts(media_item_id=item_id)
            session.add(facts)
        facts.total_plays = acc.play_count
        facts.distinct_watchers = len(acc.watchers)
        facts.last_watched_at = acc.last_watched
        facts.max_completion_pct = acc.max_completion
        facts.is_favorite_any_user = acc.favorite
        total_eps = episode_totals.get(item_id, 0)
        watched_eps = len(series_watched_eps.get(item_id, set()))
        facts.pct_episodes_watched = (
            round(watched_eps / total_eps * 100, 1) if total_eps else 0.0
        )

    for season_id, acc in season_acc.items():
        sf = await session.get(SeasonWatchFacts, season_id)
        if sf is None:
            sf = SeasonWatchFacts(season_id=season_id)
            session.add(sf)
        sf.total_plays = acc.play_count
        sf.distinct_watchers = len(acc.watchers)
        sf.last_watched_at = acc.last_watched
        season = await session.get(Season, season_id)
        ep_count = season.episode_count if season else 0
        watched_eps = len(season_watched_eps.get(season_id, set()))
        sf.pct_season_watched = (
            round(watched_eps / ep_count * 100, 1) if ep_count else 0.0
        )

    return {
        "watch_items": len(item_acc),
        "watch_seasons": len(season_acc),
        "jf_users": len(users),
    }


async def sync_jellyseerr(session: AsyncSession) -> dict[str, Any]:
    js = get_integrations().jellyseerr
    if not js.configured:
        return {"skipped": "not configured"}
    try:
        requests = await js.get_requests()
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}
    return {"requests_seen": len(requests)}


async def aggregate_playback(session: AsyncSession) -> dict[str, Any]:
    """Roll PlaybackSession rows up into per-item/season facts (§5.2).

    Only items with observed sessions are recomputed, so imported/seeded facts
    are never blown away by an empty aggregation pass.
    """
    sessions = (await session.execute(select(PlaybackSession))).scalars().all()
    by_item: dict[int, list[PlaybackSession]] = {}
    by_season: dict[int, list[PlaybackSession]] = {}
    for ps in sessions:
        if ps.media_item_id:
            by_item.setdefault(ps.media_item_id, []).append(ps)
        if ps.season_id:
            by_season.setdefault(ps.season_id, []).append(ps)

    for item_id, rows in by_item.items():
        facts = await session.get(ItemWatchFacts, item_id)
        if facts is None:
            facts = ItemWatchFacts(media_item_id=item_id)
            session.add(facts)
        ended = [r.ended_at for r in rows if r.ended_at]
        facts.total_plays = len(rows)
        facts.distinct_watchers = len({r.user_id for r in rows if r.user_id})
        facts.max_completion_pct = max(
            (r.max_position_pct for r in rows), default=facts.max_completion_pct
        )
        latest = max(ended, default=None)
        if latest and (
            facts.last_watched_at is None or latest > _aware(facts.last_watched_at)
        ):
            facts.last_watched_at = latest

    for season_id, rows in by_season.items():
        sf = await session.get(SeasonWatchFacts, season_id)
        if sf is None:
            sf = SeasonWatchFacts(season_id=season_id)
            session.add(sf)
        sf.total_plays = len(rows)
        sf.distinct_watchers = len({r.user_id for r in rows if r.user_id})
        ended = [r.ended_at for r in rows if r.ended_at]
        latest = max(ended, default=None)
        if latest and (
            sf.last_watched_at is None or latest > _aware(sf.last_watched_at)
        ):
            sf.last_watched_at = latest

    await session.commit()
    return {"items": len(by_item), "seasons": len(by_season)}


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


LIBRARY_SYNC_JOBS: tuple[tuple[str, str], ...] = (
    ("radarr", "sync_radarr"),
    ("sonarr", "sync_sonarr"),
    ("jellyfin", "sync_jellyfin"),
    ("jellyseerr", "sync_jellyseerr"),
)


async def run_library_syncs(services: set[str] | None = None) -> dict[str, Any]:
    """Run library sync jobs for configured integrations (optionally filtered by service name)."""
    from . import scheduler

    results: dict[str, Any] = {}
    for svc, job in LIBRARY_SYNC_JOBS:
        if services is not None and svc not in services:
            continue
        summary = await scheduler.run_now(job)
        if summary.get("skipped") != "not configured":
            results[job] = summary
    return results
