"""SSE stream (§12): job completions + state changes so the UI updates live."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from ..services import events as event_bus

router = APIRouter(prefix="/api/v1", tags=["events"])


@router.get("/events")
async def stream():
    async def gen():
        q = event_bus.subscribe()
        try:
            yield "retry: 3000\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=20.0)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            event_bus.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream")
