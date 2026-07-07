"""Application settings.

Bootstrap-only secrets (session secret, admin credentials) come from the
environment / .env. Integration URLs and API keys are stored in the DB and
managed through the Settings UI after first boot (env values seed the DB once).
Operational toggles (system on/off, thresholds) live in the ``settings`` table.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SWEEPARR_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Core ---
    config_dir: Path = Field(default=Path("./config"))
    timezone: str = Field(default="America/New_York")
    session_secret: str = Field(default="dev-insecure-change-me")
    session_cookie: str = "sweeparr_session"
    session_ttl_hours: int = 24 * 14

    # --- Local admin bootstrap (used only when no password_hash user exists) ---
    admin_username: str = Field(default="admin")
    admin_password: str = Field(default="admin")

    # --- Integrations (env seeds DB once on first boot; UI is authoritative after) ---
    jellyfin_url: str = ""
    jellyfin_api_key: str = ""
    jellyseerr_url: str = ""
    jellyseerr_api_key: str = ""
    sonarr_url: str = ""
    sonarr_api_key: str = ""
    radarr_url: str = ""
    radarr_api_key: str = ""
    ntfy_url: str = ""
    ntfy_topic: str = ""

    # --- Behaviour ---
    cold_start_days: int = 30

    @property
    def db_path(self) -> Path:
        return self.config_dir / "sweeparr.db"

    @property
    def db_url(self) -> str:
        return f"sqlite+aiosqlite:///{self.db_path}"

    def integration_bootstrap(self) -> dict[str, dict[str, str]]:
        return {
            "jellyfin": {"url": self.jellyfin_url, "api_key": self.jellyfin_api_key},
            "jellyseerr": {"url": self.jellyseerr_url, "api_key": self.jellyseerr_api_key},
            "sonarr": {"url": self.sonarr_url, "api_key": self.sonarr_api_key},
            "radarr": {"url": self.radarr_url, "api_key": self.radarr_api_key},
            "ntfy": {"url": self.ntfy_url, "api_key": "", "topic": self.ntfy_topic},
        }


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.config_dir.mkdir(parents=True, exist_ok=True)
    return s
