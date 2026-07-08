"""Lifecycle state machine, rule evaluation and the deletion executor (§7).

The scheduler is the single gate: there is no code path from "rule matched"
straight to "file gone". Everything is auditable and idempotent.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..models import (
    AuditLog,
    KeepRequest,
    LifecycleState,
    MediaItem,
    Protection,
    RuleSet,
    RuleTarget,
    Season,
    UnitType,
    utcnow,
)
from ..rules.engine import evaluate_tree, matched_snapshot
from . import notify
from .events import publish
from .facts import GB, build_movie_facts, build_season_facts
from .integrations import get_integrations
from .runtime import all_settings, get_setting, is_system_enabled

GB_BYTES = GB


# --------------------------------------------------------------------------- #
# Unit abstraction — a movie (MediaItem) or a TV season (Season)
# --------------------------------------------------------------------------- #
@dataclass
class Unit:
    type: str  # "movie" | "season"
    obj: Any
    item: MediaItem  # parent media_item (== obj for movies)

    @property
    def id(self) -> int:
        return self.obj.id

    @property
    def key(self) -> str:
        return f"{self.type}:{self.obj.id}"

    @property
    def size_bytes(self) -> int:
        return self.obj.size_bytes or 0


async def _movie_units(
    session: AsyncSession, library: Optional[str] = None
) -> list[Unit]:
    stmt = (
        select(MediaItem)
        .where(
            MediaItem.type == "movie",
            MediaItem.deleted_externally == False,  # noqa: E712
        )
        .options(selectinload(MediaItem.facts))
    )
    if library:
        stmt = stmt.where(MediaItem.library == library)
    items = (await session.execute(stmt)).scalars().all()
    return [Unit("movie", it, it) for it in items]


async def _season_units(
    session: AsyncSession, library: Optional[str] = None
) -> list[Unit]:
    stmt = (
        select(Season, MediaItem)
        .join(MediaItem, Season.media_item_id == MediaItem.id)
        .where(MediaItem.deleted_externally == False)  # noqa: E712
        .options(selectinload(Season.facts), selectinload(MediaItem.facts))
    )
    if library:
        stmt = stmt.where(MediaItem.library == library)
    rows = (await session.execute(stmt)).all()
    return [Unit("season", season, item) for season, item in rows]


async def get_unit(
    session: AsyncSession, unit_type: str, unit_id: int
) -> Optional[Unit]:
    if unit_type == UnitType.movie.value:
        item = await session.get(MediaItem, unit_id)
        return Unit("movie", item, item) if item else None
    season = await session.get(Season, unit_id)
    if season is None:
        return None
    item = await session.get(MediaItem, season.media_item_id)
    return Unit("season", season, item)


# --------------------------------------------------------------------------- #
# Facts + disk pressure
# --------------------------------------------------------------------------- #
async def _disk_pct_for(session: AsyncSession, item: MediaItem) -> float:
    disk = await get_setting(session, "disk") or {}
    if item.root_folder and item.root_folder in disk:
        return float(disk[item.root_folder])
    if disk:
        return float(max(disk.values()))
    return 0.0


async def build_facts(session: AsyncSession, unit: Unit) -> dict[str, Any]:
    disk_pct = await _disk_pct_for(session, unit.item)
    if unit.type == "movie":
        return await build_movie_facts(session, unit.item, disk_pct)
    return await build_season_facts(session, unit.item, unit.obj, disk_pct)


# --------------------------------------------------------------------------- #
# Protection (§6.3) — hard vetoes evaluated before any rule
# --------------------------------------------------------------------------- #
async def protection_reasons(session: AsyncSession, unit: Unit) -> list[dict[str, Any]]:
    reasons: list[dict[str, Any]] = []
    settings = await all_settings(session)

    if unit.item.unmanaged:
        reasons.append(
            {
                "kind": "unmanaged",
                "detail": "No Sonarr/Radarr counterpart to delete through",
            }
        )

    facts_tags = await build_facts(session, unit)
    if settings.get("tag_protects") and "sweeparr-keep" in (
        facts_tags.get("has_tag") or []
    ):
        reasons.append({"kind": "tag", "detail": "sweeparr-keep tag in arr"})

    if settings.get("favorite_protects") and facts_tags.get("is_favorite_any_user"):
        reasons.append({"kind": "favorite", "detail": "Jellyfin favorite"})

    if (
        settings.get("airing_protects")
        and unit.item.series_status == "continuing"
        and unit.type == "season"
    ):
        if unit.obj.is_latest_season:
            reasons.append(
                {"kind": "airing", "detail": "Latest season of a continuing series"}
            )

    window = settings.get("request_protection_days") or 0
    rda = facts_tags.get("requested_days_ago")
    if window and rda is not None and rda < window:
        reasons.append(
            {
                "kind": "request_window",
                "detail": f"Requested {int(rda)}d ago (< {window}d)",
            }
        )

    keeps = (
        (
            await session.execute(
                select(Protection).where(
                    Protection.unit_type == unit.type,
                    Protection.unit_id == unit.id,
                    Protection.kind == "keep",
                )
            )
        )
        .scalars()
        .all()
    )
    for k in keeps:
        reasons.append({"kind": "keep", "detail": k.detail or "Kept by admin"})
    return reasons


async def _sync_protection_ledger(
    session: AsyncSession, unit: Unit, protections: list[dict[str, Any]]
) -> None:
    """Persist the unit's current non-keep protection reasons (replace-all).

    This is the durable, queryable record behind "why is this kept" on the
    Keeps page, and the input ``run_lift_protections`` diffs against: once
    none of these still apply on re-check, the unit is auto-released.
    Admin keeps (``kind="keep"``) are a separate, indefinite ledger entry
    owned by ``keep_unit``/``release_unit`` and are left untouched here.
    """
    await session.execute(
        delete(Protection).where(
            Protection.unit_type == unit.type,
            Protection.unit_id == unit.id,
            Protection.kind != "keep",
        )
    )
    for p in protections:
        if p["kind"] == "keep":
            continue
        session.add(
            Protection(
                unit_type=unit.type,
                unit_id=unit.id,
                kind=p["kind"],
                detail=p.get("detail"),
            )
        )


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _grace_for(rule: RuleSet, disk_pct: float, tiers: list[dict]) -> int:
    grace = rule.grace_days
    overrides = rule.disk_overrides or []
    applicable = [t for t in overrides if disk_pct >= t.get("usage_pct", 200)]
    if applicable:
        grace = min(grace, min(t["max_grace"] for t in applicable))
    return grace


# --------------------------------------------------------------------------- #
# Rule evaluation job (§7.2 evaluate_rules)
# --------------------------------------------------------------------------- #
async def evaluate_rule(session: AsyncSession, rule: RuleSet) -> dict[str, Any]:
    """Evaluate one rule against the local DB. Returns matches + snapshots."""
    if rule.target == RuleTarget.movie.value:
        units = await _movie_units(session, rule.library)
    elif rule.target == RuleTarget.season.value:
        units = await _season_units(session, rule.library)
    else:
        units = await _season_units(session, rule.library)

    matches: list[dict[str, Any]] = []
    for unit in units:
        facts = await build_facts(session, unit)
        if evaluate_tree(rule.conditions, facts):
            protections = await protection_reasons(session, unit)
            matches.append(
                {
                    "unit": unit,
                    "facts": facts,
                    "snapshot": matched_snapshot(rule.conditions, facts),
                    "protected": bool(protections),
                    "protections": protections,
                }
            )
    return {"matches": matches}


async def run_evaluate_rules(session: AsyncSession) -> dict[str, Any]:
    if not await is_system_enabled(session):
        return {"skipped": "system_off"}

    settings = await all_settings(session)
    tiers = settings.get("disk_pressure_tiers") or []
    rules = (
        (await session.execute(select(RuleSet).order_by(RuleSet.sort_order)))
        .scalars()
        .all()
    )

    scheduled = demoted = 0
    for rule in rules:
        if not rule.enabled:
            continue
        result = await evaluate_rule(session, rule)
        matched_keys = {m["unit"].key for m in result["matches"] if not m["protected"]}

        await _demote_stale(session, rule, matched_keys)

        for m in result["matches"]:
            unit: Unit = m["unit"]
            if m["protected"]:
                await _to_kept(session, unit, rule, m["protections"], actor="system")
                continue
            obj = unit.obj
            disk_pct = m["facts"].get("disk_usage_pct", 0.0)
            grace = _grace_for(rule, disk_pct, tiers)

            if obj.state in (LifecycleState.ACTIVE.value,):
                obj.state = LifecycleState.SCHEDULED.value
                obj.delete_at = utcnow() + timedelta(days=grace)
                obj.matched_rule_id = rule.id
                obj.match_snapshot = m["snapshot"]
                obj.delay_until = None
                obj.delay_count = 0
                scheduled += 1
                _audit(
                    session,
                    unit,
                    "scheduled",
                    {
                        "rule": rule.name,
                        "grace_days": grace,
                        "delete_at": obj.delete_at.isoformat(),
                    },
                )
                if rule.notify_requester or rule.notify_admin:
                    await notify.send(
                        session,
                        subject=f"Scheduled: {unit.item.title}",
                        body=f"Leaves {obj.delete_at.date()} — rule {rule.name}",
                        media_item_id=unit.item.id,
                    )
            elif (
                obj.state == LifecycleState.SCHEDULED.value
                and obj.matched_rule_id == rule.id
            ):
                new_at = utcnow() + timedelta(days=grace)
                # A user-set delay is a hard floor: never pull deletion earlier.
                floor = _aware(obj.delay_until) if obj.delay_until else None
                if floor and new_at < floor:
                    new_at = floor
                if obj.delete_at and new_at < _aware(obj.delete_at):
                    obj.delete_at = new_at
                    _audit(
                        session,
                        unit,
                        "grace_shortened",
                        {"rule": rule.name, "delete_at": new_at.isoformat()},
                    )

        from ..models import RuleMatchHistory

        session.add(
            RuleMatchHistory(
                rule_id=rule.id,
                match_count=len(matched_keys),
                matched_unit_keys=sorted(matched_keys),
            )
        )

    await session.commit()
    publish("rules_evaluated", {"scheduled": scheduled})
    return {"scheduled": scheduled, "demoted": demoted}


async def _demote_stale(
    session: AsyncSession, rule: RuleSet, matched_keys: set[str]
) -> None:
    """Units this rule owns that no longer match are demoted back to ACTIVE."""
    for model, utype in ((MediaItem, "movie"), (Season, "season")):
        rows = (
            (
                await session.execute(
                    select(model).where(
                        model.matched_rule_id == rule.id,
                        model.state == LifecycleState.SCHEDULED.value,
                    )
                )
            )
            .scalars()
            .all()
        )
        for obj in rows:
            key = f"{utype}:{obj.id}"
            if key not in matched_keys:
                obj.state = LifecycleState.ACTIVE.value
                obj.delete_at = None
                obj.matched_rule_id = None
                obj.match_snapshot = None
                obj.delay_until = None
                obj.delay_count = 0


def _audit(
    session: AsyncSession,
    unit: Unit,
    action: str,
    detail: dict[str, Any],
    actor: str = "system",
) -> None:
    session.add(
        AuditLog(
            media_item_id=unit.item.id,
            unit_type=unit.type,
            unit_id=unit.id,
            actor=actor,
            action=action,
            detail=detail,
        )
    )


async def _to_kept(
    session: AsyncSession, unit: Unit, rule: Optional[RuleSet], protections, actor: str
) -> None:
    obj = unit.obj
    if obj.state in (
        LifecycleState.DELETING.value,
        LifecycleState.DELETED.value,
        LifecycleState.KEPT.value,
    ):
        return
    obj.state = LifecycleState.KEPT.value
    obj.delete_at = None
    obj.delay_until = None
    obj.delay_count = 0
    await _sync_protection_ledger(session, unit, protections)
    detail = {"reasons": protections}
    if rule:
        detail["rule"] = rule.name
    _audit(session, unit, "kept", detail, actor=actor)


# --------------------------------------------------------------------------- #
# Manual transitions (admin/user actions from the API)
# --------------------------------------------------------------------------- #
async def keep_unit(
    session: AsyncSession,
    unit: Unit,
    *,
    actor: str,
    reason: str | None = None,
) -> None:
    """Indefinite, admin-gated veto: pull the unit out of the rule pipeline.

    Writes a ``keep`` Protection row (read by ``protection_reasons``) so the
    unit stays off-limits to rules until an admin explicitly releases it. Any
    leftover system-protection ledger rows are cleared first — an explicit
    admin keep always supersedes and replaces them.
    """
    obj = unit.obj
    obj.state = LifecycleState.KEPT.value
    obj.delete_at = None
    obj.delay_until = None
    obj.delay_count = 0
    await session.execute(
        delete(Protection).where(
            Protection.unit_type == unit.type,
            Protection.unit_id == unit.id,
        )
    )
    session.add(
        Protection(
            unit_type=unit.type,
            unit_id=unit.id,
            kind="keep",
            detail=reason or f"kept by {actor}",
            expires_at=None,
        )
    )
    _audit(
        session,
        unit,
        "kept",
        {"reason": reason, "by": actor},
        actor=actor,
    )
    await session.commit()
    publish("unit_changed", {"key": unit.key, "state": obj.state})


async def schedule_unit(
    session: AsyncSession, unit: Unit, *, days: int, actor: str
) -> None:
    obj = unit.obj
    obj.state = LifecycleState.SCHEDULED.value
    obj.delete_at = utcnow() + timedelta(days=days)
    _audit(session, unit, "scheduled", {"manual": True, "by": actor}, actor=actor)
    await session.commit()
    publish("unit_changed", {"key": unit.key, "state": obj.state})


async def unschedule_unit(session: AsyncSession, unit: Unit, *, actor: str) -> None:
    obj = unit.obj
    obj.state = LifecycleState.ACTIVE.value
    obj.delete_at = None
    obj.matched_rule_id = None
    obj.delay_until = None
    obj.delay_count = 0
    _audit(session, unit, "unscheduled", {"by": actor}, actor=actor)
    await session.commit()
    publish("unit_changed", {"key": unit.key, "state": obj.state})


async def release_unit(session: AsyncSession, unit: Unit, *, actor: str) -> None:
    """Reverse a Keep (admin or system): clear the protection ledger and
    return the unit to ACTIVE. The unit re-enters normal rule evaluation on
    the next cycle. Whatever was protecting it is recorded on the audit row
    for traceability, even if it was a system protection with no admin action.
    """
    cleared = (
        await session.execute(
            select(Protection.kind, Protection.detail).where(
                Protection.unit_type == unit.type,
                Protection.unit_id == unit.id,
            )
        )
    ).all()
    await session.execute(
        delete(Protection).where(
            Protection.unit_type == unit.type,
            Protection.unit_id == unit.id,
        )
    )
    obj = unit.obj
    obj.state = LifecycleState.ACTIVE.value
    obj.delete_at = None
    obj.matched_rule_id = None
    obj.match_snapshot = None
    obj.delay_until = None
    obj.delay_count = 0
    _audit(
        session,
        unit,
        "released",
        {"by": actor, "cleared": [{"kind": k, "detail": d} for k, d in cleared]},
        actor=actor,
    )
    await session.commit()
    publish("unit_changed", {"key": unit.key, "state": obj.state})


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    return _aware(datetime.fromisoformat(value))


async def restore_unit(
    session: AsyncSession,
    unit: Unit,
    *,
    state: str,
    delete_at: str | None,
    delay_until: str | None,
    delay_count: int,
    matched_rule_id: int | None,
    actor: str,
) -> None:
    """Undo: restore a unit's prior lifecycle snapshot after a keep/delay.

    When restoring to a non-KEPT state we drop the whole protection ledger
    (this is the reversal of a Keep); delays never add protection rows, so
    the delete is a safe no-op.
    """
    if state != LifecycleState.KEPT.value:
        await session.execute(
            delete(Protection).where(
                Protection.unit_type == unit.type,
                Protection.unit_id == unit.id,
            )
        )
    obj = unit.obj
    obj.state = state
    obj.delete_at = _parse_dt(delete_at)
    obj.delay_until = _parse_dt(delay_until)
    obj.delay_count = delay_count or 0
    obj.matched_rule_id = matched_rule_id
    _audit(session, unit, "restored", {"state": state, "by": actor}, actor=actor)
    await session.commit()
    publish("unit_changed", {"key": unit.key, "state": obj.state})


async def delay_unit(
    session: AsyncSession,
    unit: Unit,
    *,
    days: int,
    max_count: int,
    actor: str,
    reason: str | None = None,
) -> dict[str, Any]:
    """Self-service delay: push delete_at forward by ``days`` and pin a hard floor.

    Stays SCHEDULED (no admin approval, no keep-request row). Capped to
    ``max_count`` delays per scheduled window. Returns a result dict; the unit is
    only mutated when ``ok`` is True.
    """
    obj = unit.obj
    if obj.state != LifecycleState.SCHEDULED.value:
        return {"ok": False, "reason": "not_scheduled"}
    if (obj.delay_count or 0) >= max_count:
        return {
            "ok": False,
            "reason": "capped",
            "delay_count": obj.delay_count or 0,
            "delay_remaining": 0,
        }

    base = _aware(obj.delete_at) if obj.delete_at else utcnow()
    if base < utcnow():
        base = utcnow()
    new_at = base + timedelta(days=days)
    obj.delete_at = new_at
    obj.delay_until = new_at
    obj.delay_count = (obj.delay_count or 0) + 1
    remaining = max(0, max_count - obj.delay_count)
    _audit(
        session,
        unit,
        "delayed",
        {
            "days": days,
            "count": obj.delay_count,
            "delete_at": new_at.isoformat(),
            "reason": reason,
            "by": actor,
        },
        actor=actor,
    )
    await session.commit()
    publish("unit_changed", {"key": unit.key, "delete_at": new_at.isoformat()})
    return {
        "ok": True,
        "delete_at": new_at.isoformat(),
        "delay_count": obj.delay_count,
        "delay_remaining": remaining,
    }


# --------------------------------------------------------------------------- #
# Deletion executor — the paranoid path (§7.3)
# --------------------------------------------------------------------------- #
async def run_execute_deletions(
    session: AsyncSession, *, force: bool = False
) -> dict[str, Any]:
    if not await is_system_enabled(session) and not force:
        return {"skipped": "system_off"}

    now = utcnow()
    integ = get_integrations()

    due: list[Unit] = []
    movies = (
        (
            await session.execute(
                select(MediaItem).where(
                    MediaItem.state == LifecycleState.SCHEDULED.value,
                    MediaItem.delete_at <= now,
                )
            )
        )
        .scalars()
        .all()
    )
    due += [Unit("movie", m, m) for m in movies]
    seasons = (
        (
            await session.execute(
                select(Season).where(
                    Season.state == LifecycleState.SCHEDULED.value,
                    Season.delete_at <= now,
                )
            )
        )
        .scalars()
        .all()
    )
    for s in seasons:
        item = await session.get(MediaItem, s.media_item_id)
        due.append(Unit("season", s, item))

    deleted = 0
    bytes_freed = 0
    results: list[dict[str, Any]] = []

    for unit in due:
        obj = unit.obj
        rule = (
            await session.get(RuleSet, obj.matched_rule_id)
            if obj.matched_rule_id
            else None
        )
        if rule and not rule.enabled and not force:
            continue

        # Execution hold: a pending keep request pauses deletion until an admin
        # decides. The unit stays SCHEDULED (visible, still counting down).
        pending_keep = (
            await session.execute(
                select(KeepRequest).where(
                    KeepRequest.unit_type == unit.type,
                    KeepRequest.unit_id == unit.id,
                    KeepRequest.status == "pending",
                )
            )
        ).scalar_one_or_none()
        if pending_keep is not None:
            results.append({"unit": unit.key, "result": "held_pending_keep"})
            continue

        obj.state = LifecycleState.DELETING.value
        await session.commit()

        protections = await protection_reasons(session, unit)
        if protections:
            await _to_kept(session, unit, rule, protections, actor="system")
            await session.commit()
            results.append({"unit": unit.key, "result": "protected_at_execute"})
            continue

        try:
            await _execute_one(session, unit, integ, rule)
            obj.state = LifecycleState.DELETED.value
            obj.delete_at = None
            deleted += 1
            bytes_freed += unit.size_bytes
            _audit(
                session,
                unit,
                "deleted",
                {"bytes_freed": unit.size_bytes, "rule": rule.name if rule else None},
            )
            await notify.send(
                session,
                subject=f"Deleted: {unit.item.title}",
                body=f"Freed {round(unit.size_bytes / GB_BYTES, 1)} GB",
                media_item_id=unit.item.id,
            )
            results.append({"unit": unit.key, "result": "deleted"})
        except Exception as exc:  # noqa: BLE001
            obj.state = LifecycleState.ERROR.value
            _audit(session, unit, "error", {"error": str(exc)})
            await notify.send(
                session, subject=f"Deletion failed: {unit.item.title}", body=str(exc)
            )
            results.append({"unit": unit.key, "result": "error", "detail": str(exc)})
        await session.commit()

    if deleted and integ.jellyfin.configured:
        try:
            await integ.jellyfin.refresh_library()
        except Exception:  # noqa: BLE001
            pass

    publish("deletions_run", {"deleted": deleted, "bytes_freed": bytes_freed})
    return {"deleted": deleted, "bytes_freed": bytes_freed, "results": results}


async def _execute_one(
    session: AsyncSession, unit: Unit, integ, rule: Optional[RuleSet]
) -> None:
    if unit.type == "movie":
        movie_id = unit.item.radarr_id
        if movie_id is None:
            raise RuntimeError("unmanaged movie: no Radarr id")
        if integ.radarr.configured:
            exclude = rule.add_import_list_exclusion if rule else True
            await integ.radarr.delete_movie(movie_id, add_import_list_exclusion=exclude)
            if await integ.radarr.movie_exists(movie_id):
                raise RuntimeError("Radarr still lists the movie after delete")
        return

    series_id = unit.item.sonarr_id
    season = unit.obj
    if series_id is None:
        raise RuntimeError("unmanaged series: no Sonarr id")
    if integ.sonarr.configured:
        await integ.sonarr.set_season_monitored(series_id, season.season_number, False)
        file_ids = await integ.sonarr.season_file_ids(series_id, season.season_number)
        await integ.sonarr.delete_episode_files(file_ids)
        remaining = await integ.sonarr.season_file_ids(series_id, season.season_number)
        if remaining:
            raise RuntimeError("Sonarr season still has files after delete")


async def run_lift_protections(session: AsyncSession) -> dict[str, Any]:
    """Re-check every system-protected KEPT unit and auto-release the ones
    whose protection has cleared (unfavorited, tag removed, series ended,
    request window passed, etc).

    Admin keeps (a ``Protection(kind="keep")`` row) are indefinite and are
    never touched here — only a manual Release lifts those. Everything else
    in KEPT got there via a live condition, so it's re-derived from scratch
    on every run and the unit is dropped back to ACTIVE the moment nothing
    protects it anymore, with the cleared reasons written to the audit log.
    """
    if not await is_system_enabled(session):
        return {"skipped": "system_off"}

    checked = 0
    released = 0
    for model, utype in ((MediaItem, UnitType.movie.value), (Season, "season")):
        rows = (
            (
                await session.execute(
                    select(model).where(model.state == LifecycleState.KEPT.value)
                )
            )
            .scalars()
            .all()
        )
        for obj in rows:
            has_admin_keep = (
                await session.execute(
                    select(Protection.id).where(
                        Protection.unit_type == utype,
                        Protection.unit_id == obj.id,
                        Protection.kind == "keep",
                    )
                )
            ).scalar_one_or_none()
            if has_admin_keep is not None:
                continue
            unit = await get_unit(session, utype, obj.id)
            if unit is None:
                continue
            checked += 1
            was_protected_by = (
                await session.execute(
                    select(Protection.kind, Protection.detail).where(
                        Protection.unit_type == utype,
                        Protection.unit_id == obj.id,
                    )
                )
            ).all()
            protections = await protection_reasons(session, unit)
            await _sync_protection_ledger(session, unit, protections)
            if not protections:
                obj.state = LifecycleState.ACTIVE.value
                obj.matched_rule_id = None
                obj.match_snapshot = None
                _audit(
                    session,
                    unit,
                    "auto_released",
                    {
                        "was_protected_by": [
                            {"kind": k, "detail": d} for k, d in was_protected_by
                        ]
                    },
                    actor="system",
                )
                released += 1
    await session.commit()
    if released:
        publish("unit_changed", {"auto_released": released})
    return {"checked": checked, "released": released}


async def scheduled_count(session: AsyncSession) -> int:
    m = (
        await session.execute(
            select(func.count())
            .select_from(MediaItem)
            .where(MediaItem.state == LifecycleState.SCHEDULED.value)
        )
    ).scalar_one()
    s = (
        await session.execute(
            select(func.count())
            .select_from(Season)
            .where(Season.state == LifecycleState.SCHEDULED.value)
        )
    ).scalar_one()
    return int(m) + int(s)
