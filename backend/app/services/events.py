"""Tiny in-process pub/sub for the SSE stream (§12) so the UI updates live."""

from __future__ import annotations

import asyncio
import json
from typing import Any

_subscribers: set[asyncio.Queue] = set()


def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    _subscribers.discard(q)


def publish(kind: str, payload: dict[str, Any] | None = None) -> None:
    msg = json.dumps({"kind": kind, "payload": payload or {}})
    for q in list(_subscribers):
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            pass
