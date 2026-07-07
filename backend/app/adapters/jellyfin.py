"""Jellyfin adapter (§3, §5, §8, §11).

Reads items/users/sessions and item UserData; writes are limited to library
refresh and collection maintenance (never the filesystem). Auth is credential
pass-through via ``/Users/AuthenticateByName``.
"""
from __future__ import annotations

from typing import Any, Optional

import httpx

from .base import IntegrationAdapter


class JellyfinUnreachable(RuntimeError):
    """Raised when Sweeparr cannot reach Jellyfin at all (network/DNS/timeout).

    Distinct from a rejected login so the API can report the true cause instead
    of masking connectivity failures as "invalid credentials".
    """


class JellyfinAdapter(IntegrationAdapter):
    name = "jellyfin"
    api_key_header = "X-Emby-Token"

    async def _probe(self) -> None:
        await self._request("GET", "/System/Info")

    async def get_users(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/Users") or []

    async def get_items(self, *, start_index: int = 0, limit: int = 200) -> list[dict[str, Any]]:
        fields = "ProviderIds,Path,DateCreated,UserData,RunTimeTicks"
        data = await self._request(
            "GET",
            f"/Items?Recursive=true&IncludeItemTypes=Movie,Series"
            f"&Fields={fields}&StartIndex={start_index}&Limit={limit}",
        )
        return (data or {}).get("Items", [])

    async def iter_library_items(
        self,
        *,
        include_types: str = "Movie,Series",
        limit: int = 200,
    ):
        """Yield all library items, paginating through Jellyfin results."""
        fields = "ProviderIds,Path,DateCreated,UserData,RunTimeTicks"
        start = 0
        while True:
            data = await self._request(
                "GET",
                f"/Items?Recursive=true&IncludeItemTypes={include_types}"
                f"&Fields={fields}&StartIndex={start}&Limit={limit}",
            )
            items = (data or {}).get("Items", [])
            for it in items:
                yield it
            if not items:
                break
            start += len(items)
            if start >= (data or {}).get("TotalRecordCount", 0):
                break

    async def iter_user_watch_items(
        self,
        user_id: str,
        *,
        include_types: str,
        limit: int = 200,
    ):
        """Yield items a user has played or partially watched (UserData populated)."""
        fields = "UserData,RunTimeTicks,ProviderIds,SeriesId,ParentIndexNumber,IndexNumber"
        seen: set[str] = set()
        for filters in ("IsPlayed", "IsResumable"):
            start = 0
            while True:
                data = await self._request(
                    "GET",
                    f"/Users/{user_id}/Items?Recursive=true&IncludeItemTypes={include_types}"
                    f"&Fields={fields}&Filters={filters}&StartIndex={start}&Limit={limit}",
                )
                items = (data or {}).get("Items", [])
                for it in items:
                    item_id = it.get("Id")
                    if item_id and item_id not in seen:
                        seen.add(item_id)
                        yield it
                if not items:
                    break
                start += len(items)
                if start >= (data or {}).get("TotalRecordCount", 0):
                    break

    async def get_sessions(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/Sessions") or []

    async def refresh_library(self) -> None:
        await self._request("POST", "/Library/Refresh")

    async def authenticate(self, username: str, password: str) -> Optional[dict[str, Any]]:
        """Credential pass-through login (§11).

        Returns the Jellyfin user object with Policy on success, ``None`` when
        Jellyfin explicitly rejects the credentials, and raises
        ``JellyfinUnreachable`` when the server can't be contacted — so the API
        can tell "wrong password" apart from "can't reach Jellyfin".
        """
        if not self.base_url:
            raise JellyfinUnreachable("Jellyfin URL is not configured")
        url = f"{self.base_url}/Users/AuthenticateByName"
        auth_header = (
            'MediaBrowser Client="Sweeparr", Device="Sweeparr", '
            'DeviceId="sweeparr", Version="1.0.0"'
        )
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    url,
                    headers={"X-Emby-Authorization": auth_header},
                    json={"Username": username, "Pw": password},
                )
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise JellyfinUnreachable(f"cannot connect to {self.base_url}: {exc}") from exc
        except httpx.TimeoutException as exc:
            raise JellyfinUnreachable(f"timed out contacting {self.base_url}") from exc
        except httpx.HTTPError as exc:
            raise JellyfinUnreachable(f"request to {self.base_url} failed: {exc}") from exc

        if resp.status_code in (401, 403):
            return None  # genuine credential rejection
        if resp.status_code >= 500:
            raise JellyfinUnreachable(f"Jellyfin returned {resp.status_code}")
        if resp.status_code != 200:
            return None
        return resp.json()
