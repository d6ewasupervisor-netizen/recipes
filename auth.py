import base64
import hashlib
import hmac
import json
import os
import time
from typing import Annotated

from fastapi import Cookie, HTTPException

SESSION_COOKIE = "recipes_session"
SESSION_MAX_AGE = 30 * 24 * 60 * 60  # 30 days


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def auth_enabled() -> bool:
    return bool(allowed_emails())


def allowed_emails() -> frozenset[str]:
    raw = os.environ.get("AUTH_ALLOWED_EMAILS", "")
    if not raw.strip():
        return frozenset()
    return frozenset(_normalize_email(part) for part in raw.split(",") if part.strip())


def auth_secret() -> str:
    secret = os.environ.get("AUTH_SECRET", "").strip()
    if secret:
        return secret
    if auth_enabled():
        raise RuntimeError("AUTH_SECRET is required when AUTH_ALLOWED_EMAILS is set")
    return ""


def cookie_secure() -> bool:
    explicit = os.environ.get("AUTH_COOKIE_SECURE", "").strip().lower()
    if explicit in {"1", "true", "yes"}:
        return True
    if explicit in {"0", "false", "no"}:
        return False
    return bool(os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("PORT"))


def create_session_token(email: str) -> str:
    payload = json.dumps(
        {"email": _normalize_email(email), "exp": int(time.time()) + SESSION_MAX_AGE},
        separators=(",", ":"),
    )
    sig = hmac.new(auth_secret().encode(), payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{payload}.{sig}".encode()).decode()


def verify_session_token(token: str | None) -> str | None:
    if not token or not auth_enabled():
        return None
    try:
        decoded = base64.urlsafe_b64decode(token.encode()).decode()
        payload, sig = decoded.rsplit(".", 1)
        expected = hmac.new(auth_secret().encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        data = json.loads(payload)
        if data.get("exp", 0) < time.time():
            return None
        email = _normalize_email(data.get("email", ""))
        if email not in allowed_emails():
            return None
        return email
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def require_auth(
    recipes_session: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
) -> str | None:
    if not auth_enabled():
        return None
    email = verify_session_token(recipes_session)
    if not email:
        raise HTTPException(status_code=401, detail="Sign in required")
    return email
