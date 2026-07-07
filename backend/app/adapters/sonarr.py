"""Sonarr adapter (§3, §4, §7.3).

Season deletion is the three-step paranoid path: unmonitor the season via a
series update FIRST (crash-safety — an unmonitored season can't re-grab), then
bulk-delete its episode files, then verify the season's file list is empty.
"""

from __future__ import annotations

from typing import Any

from .base import IntegrationAdapter


class SonarrAdapter(IntegrationAdapter):
    name = "sonarr"

    async def _probe(self) -> None:
        await self._request("GET", "/api/v3/system/status")

    async def get_series(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/api/v3/series") or []

    async def get_episode_files(self, series_id: int) -> list[dict[str, Any]]:
        return (
            await self._request("GET", f"/api/v3/episodefile?seriesId={series_id}")
            or []
        )

    async def get_diskspace(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/api/v3/diskspace") or []

    async def update_series(self, series: dict[str, Any]) -> dict[str, Any]:
        return await self._request("PUT", f"/api/v3/series/{series['id']}", json=series)

    async def set_season_monitored(
        self, series_id: int, season_number: int, monitored: bool
    ) -> None:
        series = await self._request("GET", f"/api/v3/series/{series_id}")
        for s in series.get("seasons", []):
            if s.get("seasonNumber") == season_number:
                s["monitored"] = monitored
        await self.update_series(series)

    async def delete_episode_files(self, file_ids: list[int]) -> None:
        if not file_ids:
            return
        await self._request(
            "DELETE", "/api/v3/episodefile/bulk", json={"episodeFileIds": file_ids}
        )

    async def season_file_ids(self, series_id: int, season_number: int) -> list[int]:
        files = await self.get_episode_files(series_id)
        return [f["id"] for f in files if f.get("seasonNumber") == season_number]

    async def add_tag(self, series_id: int, tag_id: int) -> None:
        series = await self._request("GET", f"/api/v3/series/{series_id}")
        tags = set(series.get("tags", []))
        tags.add(tag_id)
        series["tags"] = list(tags)
        await self.update_series(series)
