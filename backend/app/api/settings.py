"""Settings + connection tests + health (§11, §12).

Integration API keys are write-only in the UI and never returned. The system
on/off toggle takes effect immediately.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..schemas import SettingsPatch
from ..services import scheduler
from ..services.integrations import (
    get_integrations,
    load_integrations,
    probe_integrations,
)
from ..services.sync import run_library_syncs
from ..services.runtime import (
    INTEGRATION_SERVICES,
    all_settings,
    get_integration_config,
    is_system_enabled,
    set_integration_config,
    set_setting,
)
from .auth import Principal, require_admin

router = APIRouter(prefix="/api/v1", tags=["settings"])


async def _connection_summary(session: AsyncSession) -> dict:
    out = {}
    for svc in INTEGRATION_SERVICES:
        cfg = await get_integration_config(session, svc)
        entry = {"url": cfg.get("url", ""), "has_key": bool(cfg.get("api_key"))}
        if svc == "ntfy":
            entry["topic"] = cfg.get("topic", "")
        out[svc] = entry
    return out


@router.get("/settings")
async def get_settings_view(
    session: AsyncSession = Depends(get_session), _: Principal = Depends(require_admin)
):
    values = await all_settings(session)
    values.pop("disk", None)
    return {
        "connections": await _connection_summary(session),
        "integration_health": get_integrations().health(),
        "values": values,
        "system_enabled": await is_system_enabled(session),
        "jobs": scheduler.job_states(),
    }


@router.put("/settings")
async def update_settings(
    body: SettingsPatch,
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
):
    if body.system_enabled is not None:
        await set_setting(session, "system_enabled", body.system_enabled)
    if body.values:
        for k, v in body.values.items():
            await set_setting(session, k, v)
    if body.integrations:
        for svc, patch in body.integrations.items():
            if svc not in INTEGRATION_SERVICES:
                raise HTTPException(400, f"Unknown integration: {svc}")
            await set_integration_config(
                session,
                svc,
                url=patch.url,
                api_key=patch.api_key,
                topic=patch.topic,
            )
    await session.commit()
    integ = await load_integrations(session)
    sync_summary = None
    if body.integrations:
        await probe_integrations(integ)
        sync_summary = await run_library_syncs(set(body.integrations.keys()) - {"ntfy"})
    view = await get_settings_view(session)
    if sync_summary:
        view["sync_summary"] = sync_summary
    return view


@router.post("/settings/test/{service}")
async def test_connection(
    service: str,
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
):
    await load_integrations(session)
    integ = get_integrations()
    adapter = {
        "jellyfin": integ.jellyfin,
        "jellyseerr": integ.jellyseerr,
        "sonarr": integ.sonarr,
        "radarr": integ.radarr,
    }.get(service)
    if adapter is None:
        if service == "ntfy":
            cfg = await get_integration_config(session, "ntfy")
            if not cfg.get("url") or not cfg.get("topic"):
                return {
                    "service": service,
                    "ok": False,
                    "detail": "not configured",
                    "latency_ms": None,
                }
            return {
                "service": service,
                "ok": True,
                "detail": "configured",
                "latency_ms": None,
            }
        raise HTTPException(404, "Unknown service")
    health = await adapter.test()
    return {
        "service": service,
        "ok": health.ok,
        "detail": health.detail,
        "latency_ms": health.latency_ms,
    }
