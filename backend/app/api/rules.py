"""Rules CRUD + preview + enable/disable + QC (§6, §12).

Rules are created disabled. Live preview evaluates against the catalog with no
side effects. Enabling a rule schedules matching units for real deletion.
"""

from __future__ import annotations

from datetime import timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import (
    LifecycleState,
    MediaItem,
    RuleMatchHistory,
    RuleSet,
    RuleTarget,
    Season,
)
from ..rules.engine import FIELD_CATALOG, OPERATORS_BY_TYPE, count_condition_matches
from ..schemas import PreviewIn, RuleIn
from ..services import lifecycle
from ..services.events import publish
from .auth import Principal, require_admin

router = APIRouter(prefix="/api/v1", tags=["rules"])

GB = 1024**3


def _serialize_rule(r: RuleSet, match_count=None, match_gb=None) -> dict:
    return {
        "id": r.id,
        "name": r.name,
        "library": r.library,
        "target": r.target,
        "enabled": r.enabled,
        "conditions": r.conditions,
        "grace_days": r.grace_days,
        "disk_overrides": r.disk_overrides,
        "notify_requester": r.notify_requester,
        "notify_admin": r.notify_admin,
        "mirror_arr_tags": r.mirror_arr_tags,
        "add_import_list_exclusion": r.add_import_list_exclusion,
        "updated_at": (
            r.updated_at.replace(tzinfo=timezone.utc).isoformat()
            if r.updated_at
            else None
        ),
        "match_count": match_count,
        "match_gb": match_gb,
    }


async def _revert_rule_units(session: AsyncSession, rule_id: int) -> int:
    reverted = 0
    for model in (MediaItem, Season):
        rows = (
            (
                await session.execute(
                    select(model).where(
                        model.matched_rule_id == rule_id,
                        model.state == LifecycleState.SCHEDULED.value,
                    )
                )
            )
            .scalars()
            .all()
        )
        for obj in rows:
            obj.state = LifecycleState.ACTIVE.value
            obj.delete_at = None
            obj.matched_rule_id = None
            obj.match_snapshot = None
            reverted += 1
    return reverted


@router.get("/rules/catalog")
async def catalog(_: Principal = Depends(require_admin)):
    return {"fields": FIELD_CATALOG, "operators": OPERATORS_BY_TYPE}


@router.get("/rules")
async def list_rules(
    session: AsyncSession = Depends(get_session), _: Principal = Depends(require_admin)
):
    rules = (
        (await session.execute(select(RuleSet).order_by(RuleSet.sort_order)))
        .scalars()
        .all()
    )
    out = []
    for r in rules:
        result = await lifecycle.evaluate_rule(session, r)
        matches = [m for m in result["matches"] if not m["protected"]]
        gb = round(sum(m["unit"].size_bytes for m in matches) / GB, 1)
        out.append(_serialize_rule(r, len(matches), gb))
    return {"rules": out}


@router.get("/rules/{rule_id}")
async def get_rule(
    rule_id: int,
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
):
    r = await session.get(RuleSet, rule_id)
    if not r:
        raise HTTPException(404, "Rule not found")
    result = await lifecycle.evaluate_rule(session, r)
    matches = [m for m in result["matches"] if not m["protected"]]
    gb = round(sum(m["unit"].size_bytes for m in matches) / GB, 1)
    return _serialize_rule(r, len(matches), gb)


@router.post("/rules")
async def create_rule(
    body: RuleIn,
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
):
    r = RuleSet(
        name=body.name,
        library=body.library,
        target=body.target,
        conditions=body.conditions,
        grace_days=body.grace_days,
        disk_overrides=body.disk_overrides,
        notify_requester=body.notify_requester,
        notify_admin=body.notify_admin,
        mirror_arr_tags=body.mirror_arr_tags,
        add_import_list_exclusion=body.add_import_list_exclusion,
        enabled=False,
    )
    session.add(r)
    await session.commit()
    return _serialize_rule(r)


@router.put("/rules/{rule_id}")
async def update_rule(
    rule_id: int,
    body: RuleIn,
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
):
    r = await session.get(RuleSet, rule_id)
    if not r:
        raise HTTPException(404, "Rule not found")
    r.name = body.name
    r.library = body.library
    r.target = body.target
    r.conditions = body.conditions
    r.grace_days = body.grace_days
    r.disk_overrides = body.disk_overrides
    r.notify_requester = body.notify_requester
    r.notify_admin = body.notify_admin
    r.mirror_arr_tags = body.mirror_arr_tags
    r.add_import_list_exclusion = body.add_import_list_exclusion
    await session.commit()
    return _serialize_rule(r)


@router.delete("/rules/{rule_id}")
async def delete_rule(
    rule_id: int,
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
):
    r = await session.get(RuleSet, rule_id)
    if not r:
        raise HTTPException(404, "Rule not found")
    await _revert_rule_units(session, rule_id)
    await session.delete(r)
    await session.commit()
    publish("rule_deleted", {"rule_id": rule_id})
    return {"ok": True}


@router.post("/rules/preview")
async def preview(
    body: PreviewIn,
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
):
    """Evaluate an (even unsaved) condition tree → matching units, no side effects."""
    ephemeral = RuleSet(
        name="__preview__",
        library=body.library,
        target=body.target,
        conditions=body.conditions,
    )
    result = await lifecycle.evaluate_rule(session, ephemeral)
    matches = [m for m in result["matches"] if not m["protected"]]

    fact_rows = [m["facts"] for m in result["matches"]]
    per_condition = (
        count_condition_matches(body.conditions, fact_rows) if body.conditions else {}
    )

    items = []
    for m in matches:
        u = m["unit"]
        items.append(
            {
                "key": u.key,
                "title": u.item.title,
                "season_number": (
                    getattr(u.obj, "season_number", None)
                    if u.type == "season"
                    else None
                ),
                "size_gb": round(u.size_bytes / GB, 1),
                "snapshot": m["snapshot"],
            }
        )
    items.sort(key=lambda x: x["size_gb"], reverse=True)
    total_gb = round(sum(i["size_gb"] for i in items), 1)
    return {
        "count": len(items),
        "total_gb": total_gb,
        "items": items,
        "per_condition": per_condition,
    }


@router.post("/rules/{rule_id}/enable")
async def enable_rule(
    rule_id: int,
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
):
    r = await session.get(RuleSet, rule_id)
    if not r:
        raise HTTPException(404, "Rule not found")
    r.enabled = True
    await session.commit()
    await lifecycle.run_evaluate_rules(session)
    publish("rule_enabled", {"rule_id": r.id})
    return _serialize_rule(r)


@router.post("/rules/{rule_id}/disable")
async def disable_rule(
    rule_id: int,
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
):
    r = await session.get(RuleSet, rule_id)
    if not r:
        raise HTTPException(404, "Rule not found")
    r.enabled = False
    reverted = await _revert_rule_units(session, r.id)
    await session.commit()
    publish("rule_disabled", {"rule_id": r.id, "reverted": reverted})
    return _serialize_rule(r)


@router.get("/rules/{rule_id}/qc")
async def qc(
    rule_id: int,
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
):
    r = await session.get(RuleSet, rule_id)
    if not r:
        raise HTTPException(404, "Rule not found")

    history = (
        (
            await session.execute(
                select(RuleMatchHistory)
                .where(RuleMatchHistory.rule_id == rule_id)
                .order_by(RuleMatchHistory.ts)
            )
        )
        .scalars()
        .all()
    )
    sparkline = [
        {"ts": h.ts.replace(tzinfo=timezone.utc).isoformat(), "count": h.match_count}
        for h in history
    ]

    diff = {"added": [], "removed": []}
    if len(history) >= 2:
        prev = set(history[-2].matched_unit_keys or [])
        curr = set(history[-1].matched_unit_keys or [])
        diff["added"] = sorted(curr - prev)
        diff["removed"] = sorted(prev - curr)

    result = await lifecycle.evaluate_rule(session, r)
    matches = []
    for m in result["matches"]:
        u = m["unit"]
        matches.append(
            {
                "key": u.key,
                "unit_type": u.type,
                "unit_id": u.id,
                "title": u.item.title,
                "season_number": (
                    getattr(u.obj, "season_number", None)
                    if u.type == "season"
                    else None
                ),
                "size_gb": round(u.size_bytes / GB, 1),
                "snapshot": m["snapshot"],
                "protected": m["protected"],
                "protections": m["protections"],
                "state": u.obj.state,
            }
        )
    return {
        "rule": _serialize_rule(r),
        "sparkline": sparkline,
        "diff": diff,
        "matches": matches,
    }
