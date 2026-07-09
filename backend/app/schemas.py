"""Pydantic v2 request/response models for the API surface (§12)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class RuleIn(BaseModel):
    name: str
    library: Optional[str] = None
    target: str = "movie"
    conditions: dict[str, Any] = Field(default_factory=dict)
    grace_days: int = 30
    disk_overrides: Optional[list[dict[str, Any]]] = None
    notify_requester: bool = False
    notify_admin: bool = True
    mirror_arr_tags: bool = False
    add_import_list_exclusion: bool = True


class RuleOut(RuleIn):
    id: int
    enabled: bool
    updated_at: Optional[datetime] = None
    match_count: Optional[int] = None
    match_gb: Optional[float] = None


class PreviewIn(BaseModel):
    target: str = "movie"
    library: Optional[str] = None
    conditions: dict[str, Any] = Field(default_factory=dict)


class KeepIn(BaseModel):
    reason: Optional[str] = None


class KeepDecision(BaseModel):
    reason: Optional[str] = None


class RestoreIn(BaseModel):
    """A unit's prior lifecycle snapshot, replayed to undo a keep/delay."""

    state: str
    delete_at: Optional[str] = None
    delay_until: Optional[str] = None
    delay_count: int = 0
    matched_rule_id: Optional[int] = None


class DelayIn(BaseModel):
    reason: Optional[str] = None


class LoginIn(BaseModel):
    username: str
    password: str


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str


class IntegrationPatch(BaseModel):
    url: Optional[str] = None
    api_key: Optional[str] = None
    topic: Optional[str] = None


class SettingsPatch(BaseModel):
    system_enabled: Optional[bool] = None
    values: Optional[dict[str, Any]] = None
    integrations: Optional[dict[str, IntegrationPatch]] = None


class TestConnectionOut(BaseModel):
    service: str
    ok: bool
    detail: str
    latency_ms: Optional[int] = None


class JobScheduleIn(BaseModel):
    kind: Literal["interval", "cron"]
    minutes: Optional[int] = Field(default=None, ge=1, le=60 * 24 * 7)
    expr: Optional[str] = None
