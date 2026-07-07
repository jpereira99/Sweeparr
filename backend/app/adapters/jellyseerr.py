"""Jellyseerr adapter (§3, §5.3) — read-only."""

from __future__ import annotations

from typing import Any

from .base import IntegrationAdapter


class JellyseerrAdapter(IntegrationAdapter):
    name = "jellyseerr"

    async def _probe(self) -> None:
        await self._request("GET", "/api/v1/status")

    async def get_requests(
        self, *, take: int = 100, skip: int = 0
    ) -> list[dict[str, Any]]:
        data = await self._request("GET", f"/api/v1/request?take={take}&skip={skip}")
        return (data or {}).get("results", [])

    async def get_users(
        self, *, take: int = 100, skip: int = 0
    ) -> list[dict[str, Any]]:
        data = await self._request("GET", f"/api/v1/user?take={take}&skip={skip}")
        return (data or {}).get("results", [])
