"""Auth: local admin account + Jellyfin credential pass-through.

Login tries the local admin (password stored hashed in DB) first, then falls
through to Jellyfin ``/Users/AuthenticateByName`` for Jellyfin administrators.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import logging

from ..adapters.jellyfin import JellyfinUnreachable
from ..config import get_settings
from ..db import get_session
from ..models import User
from ..schemas import ChangePasswordIn, LoginIn
from ..services.integrations import get_integrations
from ..services.security import hash_password, verify_password

log = logging.getLogger("sweeparr.auth")

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])

_settings = get_settings()
_serializer = URLSafeTimedSerializer(_settings.session_secret, salt="sweeparr-session")


@dataclass
class Principal:
    user_id: Optional[int]
    name: str
    is_admin: bool
    jellyfin_id: Optional[str] = None
    is_local: bool = False


def _make_cookie(payload: dict) -> str:
    return _serializer.dumps(payload)


async def bootstrap_local_admin(session: AsyncSession) -> None:
    """Create the local admin from env when no password_hash user exists."""
    existing = (
        (await session.execute(select(User).where(User.password_hash.isnot(None))))
        .scalars()
        .first()
    )
    if existing:
        return
    cfg = get_settings()
    user = User(
        name=cfg.admin_username,
        password_hash=hash_password(cfg.admin_password),
        is_admin=True,
    )
    session.add(user)
    await session.commit()
    log.info("bootstrapped local admin user %r", cfg.admin_username)


async def current_principal(
    request: Request, session: AsyncSession = Depends(get_session)
) -> Principal:
    token = request.cookies.get(_settings.session_cookie)
    if token:
        try:
            data = _serializer.loads(token, max_age=_settings.session_ttl_hours * 3600)
            return Principal(
                user_id=data.get("uid"),
                name=data.get("name", "user"),
                is_admin=bool(data.get("admin")),
                jellyfin_id=data.get("jf"),
                is_local=bool(data.get("local")),
            )
        except BadSignature:
            pass
    raise HTTPException(status_code=401, detail="Not authenticated")


async def require_admin(principal: Principal = Depends(current_principal)) -> Principal:
    if not principal.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    return principal


def _set_session_cookie(response: Response, user: User, *, is_local: bool) -> None:
    cookie = _make_cookie(
        {
            "uid": user.id,
            "name": user.name,
            "admin": user.is_admin,
            "jf": user.jellyfin_id,
            "local": is_local,
        }
    )
    response.set_cookie(
        _settings.session_cookie,
        cookie,
        httponly=True,
        samesite="lax",
        max_age=_settings.session_ttl_hours * 3600,
    )


@router.post("/login")
async def login(
    body: LoginIn, response: Response, session: AsyncSession = Depends(get_session)
):
    # 1. Local admin account
    local = (
        (
            await session.execute(
                select(User).where(
                    User.name == body.username, User.password_hash.isnot(None)
                )
            )
        )
        .scalars()
        .first()
    )
    if local and verify_password(body.password, local.password_hash or ""):
        _set_session_cookie(response, local, is_local=True)
        return {"id": local.id, "name": local.name, "is_admin": local.is_admin}

    # 2. Jellyfin pass-through
    integ = get_integrations()
    try:
        jf_user = await integ.jellyfin.authenticate(body.username, body.password)
    except JellyfinUnreachable as exc:
        log.warning("Jellyfin unreachable during login: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Cannot reach Jellyfin ({exc}). Check the URL and that Sweeparr's host is allowed to reach it.",
        )

    if jf_user is None:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    user_obj = jf_user.get("User", jf_user)
    jf_id = user_obj.get("Id")
    is_admin = bool(user_obj.get("Policy", {}).get("IsAdministrator"))
    user = (
        (await session.execute(select(User).where(User.jellyfin_id == jf_id)))
        .scalars()
        .first()
    )
    if user is None:
        user = User(
            jellyfin_id=jf_id,
            name=user_obj.get("Name", body.username),
            is_admin=is_admin,
        )
        session.add(user)
    user.is_admin = is_admin
    await session.commit()

    _set_session_cookie(response, user, is_local=False)
    return {"id": user.id, "name": user.name, "is_admin": user.is_admin}


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie(_settings.session_cookie)
    return {"ok": True}


@router.get("/me")
async def me(principal: Principal = Depends(current_principal)):
    return {
        "user_id": principal.user_id,
        "name": principal.name,
        "is_admin": principal.is_admin,
        "is_local": principal.is_local,
    }


@router.post("/change-password")
async def change_password(
    body: ChangePasswordIn,
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_admin),
):
    if not principal.is_local or principal.user_id is None:
        raise HTTPException(
            status_code=400, detail="Only local admin accounts can change password here"
        )
    user = await session.get(User, principal.user_id)
    if user is None or not user.password_hash:
        raise HTTPException(status_code=400, detail="No local password on this account")
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    if len(body.new_password) < 8:
        raise HTTPException(
            status_code=400, detail="New password must be at least 8 characters"
        )
    user.password_hash = hash_password(body.new_password)
    await session.commit()
    return {"ok": True}
