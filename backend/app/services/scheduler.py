"""APScheduler jobs (§7.2).

AsyncIOScheduler, in-process. All jobs: max_instances=1, coalesce=True,
misfire_grace_time set — a NAS reboot must not cause a thundering herd or
double execution. Every run lands in the ``job_run`` table.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy import select

from ..config import get_settings
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


def _configured_timezone() -> Any:
    """Cron schedules ("daily at 4am") run in the operator's configured zone."""
    try:
        return ZoneInfo(get_settings().timezone)
    except Exception:  # noqa: BLE001
        return timezone.utc


scheduler = AsyncIOScheduler(timezone=_configured_timezone())

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


async def job_lift_protections(session):
    return await lifecycle.run_lift_protections(session)


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
    "lift_protections": {"fn": job_lift_protections, "hours": 1},
    "notify": {"fn": job_notify, "hours": 1},
    "sync_leaving_collection": {"fn": job_sync_leaving_collection, "hours": 1},
    "housekeeping": {"fn": job_housekeeping, "hours": 24},
}

# Bounds for user-configured intervals (minutes): 1 minute .. 7 days.
MIN_INTERVAL_MINUTES = 1
MAX_INTERVAL_MINUTES = 60 * 24 * 7


def _default_minutes(cfg: dict[str, Any]) -> int:
    if "minutes" in cfg:
        return int(cfg["minutes"])
    if "hours" in cfg:
        return int(cfg["hours"] * 60)
    return 60


DEFAULT_INTERVAL_MINUTES: dict[str, int] = {
    name: _default_minutes(cfg) for name, cfg in JOBS.items()
}

# Currently applied schedule per job, so job_states() can report it without
# reverse-engineering APScheduler triggers.
_schedules: dict[str, dict[str, Any]] = {}


def _clamp_minutes(minutes: int) -> int:
    return max(MIN_INTERVAL_MINUTES, min(MAX_INTERVAL_MINUTES, int(minutes)))


def _default_schedule(name: str) -> dict[str, Any]:
    return {"kind": "interval", "minutes": DEFAULT_INTERVAL_MINUTES[name]}


def normalize_schedule(schedule: Any) -> dict[str, Any]:
    """Validate + canonicalize a schedule. Raises ValueError on bad input.

    Two shapes are supported:
      - {"kind": "interval", "minutes": N}  (N clamped to [1, 7 days])
      - {"kind": "cron", "expr": "m h dom mon dow"}  (standard 5-field crontab;
        day-of-week is 0=Mon .. 6=Sun per APScheduler)
    A bare int is accepted as a legacy interval in minutes.
    """
    if isinstance(schedule, int):
        return {"kind": "interval", "minutes": _clamp_minutes(schedule)}
    if not isinstance(schedule, dict):
        raise ValueError("schedule must be an object")
    kind = schedule.get("kind")
    if kind == "interval":
        minutes = schedule.get("minutes")
        if minutes is None:
            raise ValueError("interval schedule needs 'minutes'")
        return {"kind": "interval", "minutes": _clamp_minutes(int(minutes))}
    if kind == "cron":
        expr = str(schedule.get("expr", "")).strip()
        if len(expr.split()) != 5:
            raise ValueError("cron expression must have 5 fields")
        # Raises ValueError for malformed fields.
        CronTrigger.from_crontab(expr, timezone=scheduler.timezone)
        return {"kind": "cron", "expr": expr}
    raise ValueError(f"unknown schedule kind: {kind!r}")


def _build_trigger(schedule: dict[str, Any]):
    if schedule["kind"] == "cron":
        return CronTrigger.from_crontab(schedule["expr"], timezone=scheduler.timezone)
    return IntervalTrigger(minutes=schedule["minutes"], timezone=scheduler.timezone)


def start_scheduler(overrides: dict[str, Any] | None = None) -> None:
    overrides = overrides or {}
    for name, cfg in JOBS.items():
        schedule = _default_schedule(name)
        raw = overrides.get(name)
        if raw is not None:
            try:
                schedule = normalize_schedule(raw)
            except ValueError:
                log.warning("ignoring invalid saved schedule for %s: %r", name, raw)
        _schedules[name] = schedule
        scheduler.add_job(
            _tracked,
            _build_trigger(schedule),
            args=[name, cfg["fn"]],
            id=name,
            max_instances=1,
            coalesce=True,
            misfire_grace_time=300,
        )
    scheduler.start()
    log.info("scheduler started with %d jobs", len(JOBS))


def reschedule_job(name: str, schedule: Any) -> dict[str, Any]:
    """Change a job's schedule at runtime. Returns the normalized schedule.

    Raises KeyError for unknown jobs and ValueError for invalid schedules.
    """
    if name not in JOBS:
        raise KeyError(name)
    normalized = normalize_schedule(schedule)
    scheduler.reschedule_job(name, trigger=_build_trigger(normalized))
    _schedules[name] = normalized
    log.info("rescheduled job %s to %s", name, normalized)
    return normalized


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
                "schedule": _schedules.get(name, _default_schedule(name)),
                "default_schedule": _default_schedule(name),
            }
        )
    return out
