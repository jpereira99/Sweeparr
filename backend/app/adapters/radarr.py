"""Radarr adapter (§3, §7.3)."""
from __future__ import annotations

from typing import Any

from .base import IntegrationAdapter


class RadarrAdapter(IntegrationAdapter):
    name = "radarr"

    async def _probe(self) -> None:
        await self._request("GET", "/api/v3/system/status")

    async def get_movies(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/api/v3/movie") or []

    async def get_diskspace(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/api/v3/diskspace") or []

    async def delete_movie(self, movie_id: int, *, add_import_list_exclusion: bool = True) -> None:
        # Radarr respects its own recycle-bin settings on this call.
        await self._request(
            "DELETE",
            f"/api/v3/movie/{movie_id}"
            f"?deleteFiles=true&addImportExclusion={str(add_import_list_exclusion).lower()}",
        )

    async def movie_exists(self, movie_id: int) -> bool:
        try:
            await self._request("GET", f"/api/v3/movie/{movie_id}")
            return True
        except Exception:  # noqa: BLE001
            return False
