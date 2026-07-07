"""FastAPI application entrypoint.

One container: FastAPI serves the API, runs the scheduler, and serves the built
React SPA as static files (§3). SQLite in WAL mode. No sidecars.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select

from . import __version__
from .api.auth import bootstrap_local_admin
from .config import get_settings
from .db import SessionLocal, init_db
from .models import MediaItem
from .services import scheduler
from .services.integrations import get_integrations, load_integrations, probe_integrations
from .services.runtime import bootstrap_integrations_from_env, is_system_enabled
from .services.sync import run_library_syncs

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("sweeparr")

settings = get_settings()

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
SPA_DIR = STATIC_DIR / "spa"
INJECT_DIR = STATIC_DIR / "inject"


async def _bootstrap_library_if_empty() -> None:
    try:
        async with SessionLocal() as session:
            count = (await session.execute(select(func.count()).select_from(MediaItem))).scalar_one()
        if count:
            return
        integ = get_integrations()
        if not (integ.radarr.configured or integ.sonarr.configured):
            return
        log.info("empty library — running initial sync from Sonarr/Radarr")
        summary = await run_library_syncs()
        log.info("initial sync complete: %s", summary)
    except Exception:  # noqa: BLE001
        log.exception("initial library sync failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    async with SessionLocal() as session:
        await bootstrap_integrations_from_env(session)
        await session.commit()
        await bootstrap_local_admin(session)
        integ = await load_integrations(session)
        await probe_integrations(integ)
    scheduler.start_scheduler()
    asyncio.create_task(_bootstrap_library_if_empty())
    yield
    scheduler.scheduler.shutdown(wait=False)


app = FastAPI(title="Sweeparr", version=__version__, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    allow_credentials=False,
)

from .api import (  # noqa: E402
    auth,
    dashboard,
    events,
    flags,
    jobs,
    keep,
    media,
    rules,
    schedule,
    settings as settings_api,
)

for r in (
    auth.router,
    dashboard.router,
    media.router,
    schedule.router,
    rules.router,
    keep.router,
    jobs.router,
    settings_api.router,
    events.router,
    flags.router,
):
    app.include_router(r)


@app.get("/healthz")
async def healthz():
    async with SessionLocal() as session:
        return {
            "status": "ok",
            "version": __version__,
            "system_enabled": await is_system_enabled(session),
            "integrations": get_integrations().health(),
        }


if INJECT_DIR.exists():
    app.mount("/static/inject", StaticFiles(directory=str(INJECT_DIR)), name="inject")


if SPA_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(SPA_DIR / "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        candidate = SPA_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        index = SPA_DIR / "index.html"
        if index.exists():
            return FileResponse(index)
        return JSONResponse({"detail": "SPA not built"}, status_code=404)
else:

    @app.get("/")
    async def root():
        return {
            "app": "Sweeparr",
            "version": __version__,
            "note": "SPA not built yet — run the frontend build. API is under /api/v1.",
        }
