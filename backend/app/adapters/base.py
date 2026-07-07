"""Uniform integration adapter base (§3).

Each adapter: bearer/X-Api-Key auth from settings, retry with exponential
backoff + jitter, per-service rate limiting (semaphore), a circuit breaker
(marks the integration unhealthy after N failures, surfaced in the UI), and a
``test()`` method wired to the "Test connection" button.

Adapters degrade gracefully: if no base URL is configured they report
``configured=False`` and every read returns empty rather than crashing a job.
"""
from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx


@dataclass
class AdapterHealth:
    name: str
    configured: bool = False
    ok: bool = False
    latency_ms: Optional[int] = None
    detail: str = "not configured"
    consecutive_failures: int = 0
    circuit_open: bool = False


class IntegrationAdapter:
    name = "base"
    api_key_header = "X-Api-Key"

    def __init__(self, base_url: str, api_key: str, *, max_failures: int = 5, rate_limit: int = 8):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        configured = bool(base_url and api_key)
        self.health = AdapterHealth(
            name=self.name,
            configured=configured,
            detail="not configured" if not configured else "pending",
        )
        self._sem = asyncio.Semaphore(rate_limit)
        self._max_failures = max_failures

    @property
    def configured(self) -> bool:
        return self.health.configured

    def _headers(self) -> dict[str, str]:
        if self.api_key_header.lower() == "authorization":
            return {"Authorization": f"Bearer {self.api_key}"}
        return {self.api_key_header: self.api_key}

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        if not self.configured:
            raise RuntimeError(f"{self.name} not configured")
        if self.health.circuit_open:
            raise RuntimeError(f"{self.name} circuit open")

        url = f"{self.base_url}{path}"
        last_exc: Optional[Exception] = None
        async with self._sem:
            for attempt in range(3):
                try:
                    started = time.perf_counter()
                    async with httpx.AsyncClient(timeout=15.0) as client:
                        resp = await client.request(method, url, headers=self._headers(), **kwargs)
                    resp.raise_for_status()
                    self.health.ok = True
                    self.health.consecutive_failures = 0
                    self.health.detail = "ok"
                    self.health.latency_ms = int((time.perf_counter() - started) * 1000)
                    if resp.content and "application/json" in resp.headers.get("content-type", ""):
                        return resp.json()
                    return resp.text
                except Exception as exc:  # noqa: BLE001
                    last_exc = exc
                    await asyncio.sleep((2 ** attempt) * 0.25 + random.random() * 0.2)

        # All retries failed — trip the breaker if we've crossed the threshold.
        self.health.ok = False
        self.health.consecutive_failures += 1
        self.health.detail = _describe_error(last_exc)
        if self.health.consecutive_failures >= self._max_failures:
            self.health.circuit_open = True
        raise last_exc if last_exc else RuntimeError("request failed")

    async def test(self) -> AdapterHealth:
        """Reset the breaker and probe the service for the Test button."""
        self.health.circuit_open = False
        self.health.consecutive_failures = 0
        if not self.configured:
            self.health.ok = False
            self.health.detail = "not configured"
            return self.health
        try:
            await self._probe()
            self.health.ok = True
            self.health.detail = "ok"
        except Exception as exc:  # noqa: BLE001
            self.health.ok = False
            self.health.detail = _describe_error(exc)
        return self.health

    async def _probe(self) -> None:  # overridden per adapter
        await self._request("GET", "/")


def _describe_error(exc: Optional[Exception]) -> str:
    if exc is None:
        return "unknown error"
    if isinstance(exc, httpx.HTTPStatusError):
        return f"{exc.response.status_code} {exc.response.reason_phrase}"
    if isinstance(exc, httpx.ConnectError):
        return "connection refused"
    if isinstance(exc, httpx.TimeoutException):
        return "timeout"
    return type(exc).__name__
