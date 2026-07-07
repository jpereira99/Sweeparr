"""Notification channel abstraction (§8.3): ntfy first, generic webhook, and a
DB-logged fallback so notifications are always auditable even without a channel.
"""

from __future__ import annotations

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Notification
from .integrations import get_integrations


async def send(
    session: AsyncSession,
    *,
    subject: str,
    body: str = "",
    target: str | None = None,
    media_item_id: int | None = None,
) -> None:
    integ = get_integrations()
    channel = "log"
    status = "logged"
    if integ.ntfy_url and integ.ntfy_topic:
        channel = "ntfy"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(
                    f"{integ.ntfy_url.rstrip('/')}/{integ.ntfy_topic}",
                    content=body or subject,
                    headers={"Title": subject},
                )
            status = "sent"
        except Exception:  # noqa: BLE001
            status = "failed"

    session.add(
        Notification(
            channel=channel,
            target=target,
            subject=subject,
            status=status,
            media_item_id=media_item_id,
        )
    )
