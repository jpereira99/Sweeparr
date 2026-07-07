"""Registry of integration adapters, built from DB-backed settings."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from ..adapters import JellyfinAdapter, JellyseerrAdapter, RadarrAdapter, SonarrAdapter
from .runtime import all_integration_configs


class Integrations:
    def __init__(self, configs: dict[str, dict[str, str]]) -> None:
        jf = configs.get("jellyfin", {})
        js = configs.get("jellyseerr", {})
        sn = configs.get("sonarr", {})
        rd = configs.get("radarr", {})
        self.jellyfin = JellyfinAdapter(jf.get("url", ""), jf.get("api_key", ""))
        self.jellyseerr = JellyseerrAdapter(js.get("url", ""), js.get("api_key", ""))
        self.sonarr = SonarrAdapter(sn.get("url", ""), sn.get("api_key", ""))
        self.radarr = RadarrAdapter(rd.get("url", ""), rd.get("api_key", ""))
        self.ntfy_url = configs.get("ntfy", {}).get("url", "")
        self.ntfy_topic = configs.get("ntfy", {}).get("topic", "")

    def all(self) -> list:
        return [self.jellyfin, self.jellyseerr, self.sonarr, self.radarr]

    def health(self) -> list[dict]:
        out = []
        for a in self.all():
            h = a.health
            out.append(
                {
                    "name": h.name,
                    "configured": h.configured,
                    "ok": h.ok,
                    "latency_ms": h.latency_ms,
                    "detail": h.detail,
                    "circuit_open": h.circuit_open,
                }
            )
        ntfy_ok = bool(self.ntfy_url and self.ntfy_topic)
        out.append(
            {
                "name": "ntfy",
                "configured": ntfy_ok,
                "ok": ntfy_ok,
                "latency_ms": None,
                "detail": "configured" if ntfy_ok else "not configured",
                "circuit_open": False,
            }
        )
        return out


_integrations: Integrations | None = None


def get_integrations() -> Integrations:
    global _integrations
    if _integrations is None:
        _integrations = Integrations({})
    return _integrations


async def load_integrations(session: AsyncSession) -> Integrations:
    global _integrations
    configs = await all_integration_configs(session)
    _integrations = Integrations(configs)
    return _integrations


async def probe_integrations(integ: Integrations | None = None) -> Integrations:
    integ = integ or get_integrations()
    for adapter in integ.all():
        if adapter.configured:
            await adapter.test()
    return integ
