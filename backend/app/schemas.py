"""Pydantic v2 request/response models for the API surface (§12)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

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
    days: Optional[int] = 30  # None => forever


class KeepDecision(BaseModel):
    reason: Optional[str] = None
    days: Optional[int] = 60


class PostponeIn(BaseModel):
    days: int = 30


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
