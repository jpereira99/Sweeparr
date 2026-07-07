"""APScheduler jobs (§7.2).

AsyncIOScheduler, in-process. All jobs: max_instances=1, coalesce=True,
misfire_grace_time set — a NAS reboot must not cause a thundering herd or
double execution. Every run lands in the ``job_run`` table.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import select

from ..db import SessionLocal
from ..models import (
    AuditLog,
    JobRun,
    LifecycleState,
    MediaItem,
    Season,
    utcnow,
)
from . import lifecycle, sync
from .events import publish

log = logging.getLogger("sweeparr.scheduler")

scheduler = AsyncIOScheduler(timezone="UTC")

JobFn = Callable[..., Awaitable[dict[str, Any]]]


async def _tracked(job_name: str, fn: JobFn) -> dict[str, Any]:
    async with SessionLocal() as session:
        run = JobRun(job_name=job_name, status="running")
        session.add(run)
        await session.commit()
        summary: dict[str, Any] = {}
        try:
            summary = await fn(session) or {}
            run.status = "ok"
        except Exception as exc:  # noqa: BLE001
            log.exception("job %s failed", job_name)
            run.status = "error"
            summary = {"error": str(exc)}
        run.finished_at = utcnow()
        run.summary = summary
        await session.merge(run)
        await session.commit()
        publish("job_run", {"job": job_name, "status": run.status, "summary": summary})
        return summary


# --- Job bodies ------------------------------------------------------------ #
async def job_sync_radarr(session):
    return await sync.sync_radarr(session)


async def job_sync_sonarr(session):
    return await sync.sync_sonarr(session)


async def job_sync_jellyfin(session):
    return await sync.sync_jellyfin(session)


async def job_sync_jellyseerr(session):
    return await sync.sync_jellyseerr(session)


async def job_aggregate_playback(session):
    return await sync.aggregate_playback(session)


async def job_evaluate_rules(session):
    return await lifecycle.run_evaluate_rules(session)


async def job_execute_deletions(session):
    return await lifecycle.run_execute_deletions(session)


async def job_notify(session):
    return {"reminders": 0}


async def job_sync_leaving_collection(session):
    scheduled = await lifecycle.scheduled_count(session)
    return {"leaving_soon_members": scheduled}


async def job_housekeeping(session):
    # Prune raw playback events older than 90 days; snapshot health.
    from ..models import PlaybackEvent

    cutoff = utcnow() - timedelta(days=90)
    old = (
        (await session.execute(select(PlaybackEvent).where(PlaybackEvent.ts < cutoff)))
        .scalars()
        .all()
    )
    for e in old:
        await session.delete(e)
    await session.commit()
    return {"pruned_events": len(old)}


JOBS: dict[str, dict[str, Any]] = {
    "sync_radarr": {"fn": job_sync_radarr, "minutes": 45},
    "sync_sonarr": {"fn": job_sync_sonarr, "minutes": 45},
    "sync_jellyfin": {"fn": job_sync_jellyfin, "minutes": 45},
    "sync_jellyseerr": {"fn": job_sync_jellyseerr, "minutes": 30},
    "aggregate_playback": {"fn": job_aggregate_playback, "minutes": 15},
    "evaluate_rules": {"fn": job_evaluate_rules, "hours": 8},
    "execute_deletions": {"fn": job_execute_deletions, "hours": 1},
    "notify": {"fn": job_notify, "hours": 1},
    "sync_leaving_collection": {"fn": job_sync_leaving_collection, "hours": 1},
    "housekeeping": {"fn": job_housekeeping, "hours": 24},
}


def start_scheduler() -> None:
    for name, cfg in JOBS.items():
        trigger_kwargs = {k: v for k, v in cfg.items() if k in ("minutes", "hours")}
        scheduler.add_job(
            _tracked,
            "interval",
            args=[name, cfg["fn"]],
            id=name,
            max_instances=1,
            coalesce=True,
            misfire_grace_time=300,
            **trigger_kwargs,
        )
    scheduler.start()
    log.info("scheduler started with %d jobs", len(JOBS))


async def run_now(name: str) -> dict[str, Any]:
    cfg = JOBS.get(name)
    if not cfg:
        raise KeyError(name)
    return await _tracked(name, cfg["fn"])


def pause_job(name: str) -> None:
    scheduler.pause_job(name)


def resume_job(name: str) -> None:
    scheduler.resume_job(name)


def job_states() -> list[dict[str, Any]]:
    out = []
    for name in JOBS:
        job = scheduler.get_job(name)
        nxt = job.next_run_time if job else None
        paused = job is not None and job.next_run_time is None
        out.append(
            {
                "name": name,
                "next_run": nxt.astimezone(timezone.utc).isoformat() if nxt else None,
                "paused": paused,
            }
        )
    return out
