"""Async SQLite engine with WAL discipline (§11).

WAL + synchronous=NORMAL + busy_timeout + foreign_keys ON, applied on every
connection. Writes go through short transactions; sessions are never held
across an ``await`` to an external HTTP call.
"""
from __future__ import annotations

import logging
from collections.abc import AsyncIterator

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from .config import get_settings

log = logging.getLogger("sweeparr.db")


class Base(DeclarativeBase):
    pass


_settings = get_settings()

engine: AsyncEngine = create_async_engine(
    _settings.db_url,
    echo=False,
    future=True,
    connect_args={"timeout": 30},
)


@event.listens_for(engine.sync_engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record):  # noqa: ANN001
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()


SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session


async def _column_exists(conn, table: str, column: str) -> bool:
    rows = (await conn.execute(text(f"PRAGMA table_info({table})"))).fetchall()
    return any(r[1] == column for r in rows)


async def _migrate_schema() -> None:
    """One-time idempotent migrations for existing SQLite databases."""
    async with engine.begin() as conn:
        # rule_set.enabled
        if not await _column_exists(conn, "rule_set", "enabled"):
            if await _column_exists(conn, "rule_set", "status"):
                await conn.execute(
                    text(
                        "ALTER TABLE rule_set ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT 0"
                    )
                )
                await conn.execute(
                    text("UPDATE rule_set SET enabled = 1 WHERE status = 'armed'")
                )
            else:
                await conn.execute(
                    text(
                        "ALTER TABLE rule_set ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT 0"
                    )
                )

        # user.password_hash
        if not await _column_exists(conn, "user", "password_hash"):
            await conn.execute(
                text("ALTER TABLE user ADD COLUMN password_hash VARCHAR(256)")
            )

        # CANDIDATE shadow units -> ACTIVE
        await conn.execute(
            text("UPDATE media_item SET state = 'ACTIVE' WHERE state = 'CANDIDATE'")
        )
        await conn.execute(
            text("UPDATE season SET state = 'ACTIVE' WHERE state = 'CANDIDATE'")
        )

        # Drop legacy rule columns when supported (SQLite 3.35+)
        for col in ("status", "dry_run_since"):
            if await _column_exists(conn, "rule_set", col):
                try:
                    await conn.execute(text(f"ALTER TABLE rule_set DROP COLUMN {col}"))
                except Exception as exc:  # noqa: BLE001
                    log.debug("could not drop rule_set.%s: %s", col, exc)


async def init_db() -> None:
    # Models are imported for side effects (table registration).
    from . import models  # noqa: F401

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await _migrate_schema()
