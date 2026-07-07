"""Runtime operational settings — DB-backed."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models import Setting

INTEGRATION_SERVICES = ("jellyfin", "jellyseerr", "sonarr", "radarr", "ntfy")

DEFAULTS: dict[str, Any] = {
    "system_enabled": True,
    "disk_pressure_tiers": [
        {"usage_pct": 85, "max_grace": 14},
        {"usage_pct": 92, "max_grace": 5},
    ],
    "gb_per_hour_threshold": 3.0,
    "favorite_protects": True,
    "airing_protects": True,
    "request_protection_days": 30,
    "leaving_soon_collection": True,
}


async def get_setting(session: AsyncSession, key: str) -> Any:
    row = await session.get(Setting, key)
    if row is None:
        return DEFAULTS.get(key)
    return row.value.get("v") if isinstance(row.value, dict) else row.value


async def set_setting(session: AsyncSession, key: str, value: Any) -> None:
    row = await session.get(Setting, key)
    if row is None:
        row = Setting(key=key, value={"v": value})
        session.add(row)
    else:
        row.value = {"v": value}
    await session.flush()


async def all_settings(session: AsyncSession) -> dict[str, Any]:
    result = {**DEFAULTS}
    rows = (await session.execute(select(Setting))).scalars().all()
    for r in rows:
        result[r.key] = r.value.get("v") if isinstance(r.value, dict) else r.value
    return result


async def is_system_enabled(session: AsyncSession) -> bool:
    return bool(await get_setting(session, "system_enabled"))


def _integration_key(service: str) -> str:
    return f"integration_{service}"


async def get_integration_config(session: AsyncSession, service: str) -> dict[str, str]:
    stored = await get_setting(session, _integration_key(service))
    if isinstance(stored, dict):
        return {
            "url": str(stored.get("url") or ""),
            "api_key": str(stored.get("api_key") or ""),
            **({"topic": str(stored.get("topic") or "")} if service == "ntfy" else {}),
        }
    return {"url": "", "api_key": "", **({"topic": ""} if service == "ntfy" else {})}


async def all_integration_configs(session: AsyncSession) -> dict[str, dict[str, str]]:
    return {
        svc: await get_integration_config(session, svc) for svc in INTEGRATION_SERVICES
    }


async def set_integration_config(
    session: AsyncSession,
    service: str,
    *,
    url: str | None = None,
    api_key: str | None = None,
    topic: str | None = None,
) -> dict[str, str]:
    current = await get_integration_config(session, service)
    if url is not None:
        current["url"] = url
    if api_key is not None and api_key != "":
        current["api_key"] = api_key
    if service == "ntfy" and topic is not None:
        current["topic"] = topic
    await set_setting(session, _integration_key(service), current)
    return current


async def bootstrap_integrations_from_env(session: AsyncSession) -> None:
    """Seed integration settings from env once when the DB has no integration rows."""
    bootstrap = get_settings().integration_bootstrap()
    for service in INTEGRATION_SERVICES:
        key = _integration_key(service)
        if await session.get(Setting, key) is not None:
            continue
        env_cfg = bootstrap.get(service, {})
        if not any(env_cfg.get(k) for k in ("url", "api_key", "topic")):
            await set_setting(
                session,
                key,
                {
                    "url": "",
                    "api_key": "",
                    **({"topic": ""} if service == "ntfy" else {}),
                },
            )
        else:
            await set_setting(session, key, env_cfg)
