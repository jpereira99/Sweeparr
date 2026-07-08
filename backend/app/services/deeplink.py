"""Stateless signed tokens for the public Jellyfin "Request to keep" deep-link
(§8.2).

The /flags endpoint mints these and /keep/{token} resolves them. We can't mint
a real KeepRequest row just to hand out a token — an unrequested
KeepRequest would show up as status="pending" and lifecycle.protection_reasons
treats any pending/approved KeepRequest as a protection, which would silently
stop every scheduled item from ever being deleted. So the token just names the
unit (type + id) and is verified, not looked up, on resolution.
"""

from __future__ import annotations

from itsdangerous import BadSignature, URLSafeSerializer

from ..config import get_settings

_SALT = "sweeparr-keep-link"


def _serializer() -> URLSafeSerializer:
    return URLSafeSerializer(get_settings().session_secret, salt=_SALT)


def make_unit_token(unit_type: str, unit_id: int) -> str:
    return _serializer().dumps({"t": unit_type, "i": unit_id})


def read_unit_token(token: str) -> tuple[str, int] | None:
    try:
        data = _serializer().loads(token)
        return str(data["t"]), int(data["i"])
    except (BadSignature, KeyError, TypeError, ValueError):
        return None
