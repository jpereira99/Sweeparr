"""SQLAlchemy models — the core tables from §10.

The polymorphic "deletable unit" (movie | season) carries the lifecycle
columns. For movies those columns live on ``MediaItem``; for TV they live on
``Season``. Everything references ``media_item.id``, never a service-specific id.
"""

from __future__ import annotations

import enum
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class MediaType(str, enum.Enum):
    movie = "movie"
    series = "series"


class LifecycleState(str, enum.Enum):
    ACTIVE = "ACTIVE"
    SCHEDULED = "SCHEDULED"
    DELETING = "DELETING"
    DELETED = "DELETED"
    KEPT = "KEPT"
    ERROR = "ERROR"


class RuleTarget(str, enum.Enum):
    movie = "movie"
    season = "season"
    series = "series"


class UnitType(str, enum.Enum):
    movie = "movie"
    season = "season"


# --------------------------------------------------------------------------- #
# Identity hub
# --------------------------------------------------------------------------- #
class MediaItem(Base):
    __tablename__ = "media_item"

    id: Mapped[int] = mapped_column(primary_key=True)
    type: Mapped[str] = mapped_column(String(16), index=True)
    title: Mapped[str] = mapped_column(String(512))
    year: Mapped[int | None] = mapped_column(Integer, nullable=True)

    tmdb_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    tvdb_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    imdb_id: Mapped[str | None] = mapped_column(String(32), index=True, nullable=True)
    jellyfin_id: Mapped[str | None] = mapped_column(
        String(64), index=True, nullable=True
    )
    sonarr_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    radarr_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    library: Mapped[str | None] = mapped_column(String(128), index=True, nullable=True)
    root_folder: Mapped[str | None] = mapped_column(String(512), nullable=True)
    path: Mapped[str | None] = mapped_column(Text, nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    quality: Mapped[str | None] = mapped_column(String(64), nullable=True)
    resolution: Mapped[str | None] = mapped_column(String(32), nullable=True)
    runtime_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)

    date_added_arr: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    date_created_jf: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    monitored: Mapped[bool] = mapped_column(Boolean, default=True)
    series_status: Mapped[str | None] = mapped_column(
        String(32), nullable=True
    )  # ended|continuing
    unmanaged: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_externally: Mapped[bool] = mapped_column(Boolean, default=False)
    match_confidence: Mapped[str] = mapped_column(
        String(16), default="high"
    )  # high|low_confidence

    # Lifecycle columns — used for MOVIES (seasons carry their own).
    state: Mapped[str] = mapped_column(
        String(16), default=LifecycleState.ACTIVE.value, index=True
    )
    delete_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    matched_rule_id: Mapped[int | None] = mapped_column(
        ForeignKey("rule_set.id"), nullable=True
    )
    match_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Self-service delay: hard floor for delete_at + count within the window.
    delay_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    delay_count: Mapped[int] = mapped_column(Integer, default=0)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow
    )

    seasons: Mapped[list["Season"]] = relationship(
        back_populates="media_item", cascade="all, delete-orphan"
    )
    facts: Mapped["ItemWatchFacts | None"] = relationship(
        back_populates="media_item", uselist=False, cascade="all, delete-orphan"
    )

    __table_args__ = (Index("ix_media_state_delete", "state", "delete_at"),)


class Season(Base):
    __tablename__ = "season"

    id: Mapped[int] = mapped_column(primary_key=True)
    media_item_id: Mapped[int] = mapped_column(ForeignKey("media_item.id"), index=True)
    season_number: Mapped[int] = mapped_column(Integer)
    monitored: Mapped[bool] = mapped_column(Boolean, default=True)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    episode_count: Mapped[int] = mapped_column(Integer, default=0)
    newest_file_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    jellyfin_season_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    is_latest_season: Mapped[bool] = mapped_column(Boolean, default=False)

    # Lifecycle columns for the season deletable unit.
    state: Mapped[str] = mapped_column(
        String(16), default=LifecycleState.ACTIVE.value, index=True
    )
    delete_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    matched_rule_id: Mapped[int | None] = mapped_column(
        ForeignKey("rule_set.id"), nullable=True
    )
    match_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Self-service delay: hard floor for delete_at + count within the window.
    delay_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    delay_count: Mapped[int] = mapped_column(Integer, default=0)

    media_item: Mapped[MediaItem] = relationship(back_populates="seasons")
    facts: Mapped["SeasonWatchFacts | None"] = relationship(
        back_populates="season", uselist=False, cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint("media_item_id", "season_number", name="uq_season"),
        Index("ix_season_state_delete", "state", "delete_at"),
    )


class EpisodeFile(Base):
    __tablename__ = "episode_file"

    id: Mapped[int] = mapped_column(primary_key=True)
    season_id: Mapped[int] = mapped_column(ForeignKey("season.id"), index=True)
    episode: Mapped[int] = mapped_column(Integer)
    sonarr_file_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    air_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    jf_id: Mapped[str | None] = mapped_column(String(64), nullable=True)


class ArrTag(Base):
    __tablename__ = "arr_tag"
    id: Mapped[int] = mapped_column(primary_key=True)
    media_item_id: Mapped[int] = mapped_column(ForeignKey("media_item.id"), index=True)
    tag: Mapped[str] = mapped_column(String(128))


# --------------------------------------------------------------------------- #
# People & requests
# --------------------------------------------------------------------------- #
class User(Base):
    __tablename__ = "user"
    id: Mapped[int] = mapped_column(primary_key=True)
    jellyfin_id: Mapped[str | None] = mapped_column(
        String(64), index=True, nullable=True
    )
    jellyseerr_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    name: Mapped[str] = mapped_column(String(128))
    email: Mapped[str | None] = mapped_column(String(256), nullable=True)
    password_hash: Mapped[str | None] = mapped_column(String(256), nullable=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    last_active_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Request(Base):
    __tablename__ = "request"
    id: Mapped[int] = mapped_column(primary_key=True)
    media_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("media_item.id"), index=True, nullable=True
    )
    jellyseerr_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    requester_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id"), nullable=True
    )
    season_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    requested_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="available")


# --------------------------------------------------------------------------- #
# Playback
# --------------------------------------------------------------------------- #
class PlaybackEvent(Base):
    __tablename__ = "playback_event"
    id: Mapped[int] = mapped_column(primary_key=True)
    raw: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("user.id"), nullable=True)
    jellyfin_item_id: Mapped[str | None] = mapped_column(
        String(64), index=True, nullable=True
    )
    kind: Mapped[str] = mapped_column(String(32))  # PlaybackStart|Progress|Stop
    position_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class PlaybackSession(Base):
    __tablename__ = "playback_session"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("user.id"), nullable=True)
    media_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("media_item.id"), index=True, nullable=True
    )
    season_id: Mapped[int | None] = mapped_column(
        ForeignKey("season.id"), index=True, nullable=True
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime, index=True, nullable=True
    )
    seconds_watched: Mapped[int] = mapped_column(Integer, default=0)
    max_position_pct: Mapped[float] = mapped_column(Float, default=0.0)


class ItemWatchFacts(Base):
    """Materialized per-item facts consumed by the rule engine."""

    __tablename__ = "item_watch_facts"
    media_item_id: Mapped[int] = mapped_column(
        ForeignKey("media_item.id"), primary_key=True
    )
    last_watched_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    total_plays: Mapped[int] = mapped_column(Integer, default=0)
    distinct_watchers: Mapped[int] = mapped_column(Integer, default=0)
    max_completion_pct: Mapped[float] = mapped_column(Float, default=0.0)
    watched_by_requester: Mapped[bool] = mapped_column(Boolean, default=False)
    is_favorite_any_user: Mapped[bool] = mapped_column(Boolean, default=False)
    pct_episodes_watched: Mapped[float] = mapped_column(Float, default=0.0)
    observed_since: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    media_item: Mapped[MediaItem] = relationship(back_populates="facts")


class SeasonWatchFacts(Base):
    __tablename__ = "season_watch_facts"
    season_id: Mapped[int] = mapped_column(ForeignKey("season.id"), primary_key=True)
    last_watched_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    total_plays: Mapped[int] = mapped_column(Integer, default=0)
    distinct_watchers: Mapped[int] = mapped_column(Integer, default=0)
    pct_season_watched: Mapped[float] = mapped_column(Float, default=0.0)
    watched_by_requester: Mapped[bool] = mapped_column(Boolean, default=False)
    observed_since: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    season: Mapped[Season] = relationship(back_populates="facts")


# --------------------------------------------------------------------------- #
# Rules, lifecycle helpers, audit
# --------------------------------------------------------------------------- #
class RuleSet(Base):
    __tablename__ = "rule_set"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    library: Mapped[str | None] = mapped_column(String(128), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    target: Mapped[str] = mapped_column(String(16), default=RuleTarget.movie.value)
    conditions: Mapped[dict] = mapped_column(JSON, default=dict)
    grace_days: Mapped[int] = mapped_column(Integer, default=30)
    disk_overrides: Mapped[list | None] = mapped_column(JSON, nullable=True)
    notify_requester: Mapped[bool] = mapped_column(Boolean, default=False)
    notify_admin: Mapped[bool] = mapped_column(Boolean, default=True)
    mirror_arr_tags: Mapped[bool] = mapped_column(Boolean, default=False)
    add_import_list_exclusion: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow
    )


class RuleMatchHistory(Base):
    """Daily match-count snapshots powering the QC sparkline + diff."""

    __tablename__ = "rule_match_history"
    id: Mapped[int] = mapped_column(primary_key=True)
    rule_id: Mapped[int] = mapped_column(ForeignKey("rule_set.id"), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    match_count: Mapped[int] = mapped_column(Integer, default=0)
    matched_unit_keys: Mapped[list | None] = mapped_column(JSON, nullable=True)


class KeepRequest(Base):
    __tablename__ = "keep_request"
    id: Mapped[int] = mapped_column(primary_key=True)
    unit_type: Mapped[str] = mapped_column(String(16))
    unit_id: Mapped[int] = mapped_column(Integer, index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("user.id"), nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), default="pending"
    )  # pending|approved|denied
    token: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    decided_by: Mapped[int | None] = mapped_column(ForeignKey("user.id"), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    decision_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Protection(Base):
    __tablename__ = "protection"
    id: Mapped[int] = mapped_column(primary_key=True)
    unit_type: Mapped[str] = mapped_column(String(16))
    unit_id: Mapped[int] = mapped_column(Integer, index=True)
    kind: Mapped[str] = mapped_column(
        String(32)
    )  # tag|favorite|keep|request_window|airing|unmanaged
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    media_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("media_item.id"), nullable=True
    )
    unit_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    unit_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    actor: Mapped[str] = mapped_column(String(64), default="system")
    action: Mapped[str] = mapped_column(String(64), index=True)
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class JobRun(Base):
    __tablename__ = "job_run"
    id: Mapped[int] = mapped_column(primary_key=True)
    job_name: Mapped[str] = mapped_column(String(64), index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), default="running"
    )  # running|ok|error
    summary: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class Notification(Base):
    __tablename__ = "notification"
    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    channel: Mapped[str] = mapped_column(String(32))
    target: Mapped[str | None] = mapped_column(String(256), nullable=True)
    subject: Mapped[str] = mapped_column(String(256))
    status: Mapped[str] = mapped_column(String(16), default="sent")
    media_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("media_item.id"), nullable=True
    )


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[dict | None] = mapped_column(JSON, nullable=True)
