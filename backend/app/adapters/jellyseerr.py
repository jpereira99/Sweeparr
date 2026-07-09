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

    async def _paged(
        self, path: str, *, take: int = 100, max_items: int = 100_000
    ) -> list[dict[str, Any]]:
        """Walk every page of a Jellyseerr list endpoint via its ``pageInfo``."""
        results: list[dict[str, Any]] = []
        skip = 0
        while True:
            sep = "&" if "?" in path else "?"
            data = (
                await self._request("GET", f"{path}{sep}take={take}&skip={skip}") or {}
            )
            page = data.get("results", []) or []
            results.extend(page)
            page_info = data.get("pageInfo") or {}
            pages = page_info.get("pages")
            current = page_info.get("page")
            if pages is not None and current is not None:
                if current >= pages:
                    break
            elif len(page) < take:
                break
            skip += take
            if skip >= max_items:
                break
        return results

    async def get_all_requests(self, *, take: int = 100) -> list[dict[str, Any]]:
        return await self._paged("/api/v1/request", take=take)

    async def get_all_users(self, *, take: int = 100) -> list[dict[str, Any]]:
        return await self._paged("/api/v1/user", take=take)
