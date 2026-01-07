"""JWT token generation and validation."""

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from jose import JWTError, jwt

from utils.config import config
from db.aurora import get_aurora_client, param

logger = logging.getLogger(__name__)

ALGORITHM = "HS256"
TOKEN_TYPE = "Bearer"

_jwt_secret: Optional[str] = None


def _get_jwt_secret() -> str:
    """Get or generate JWT secret."""
    global _jwt_secret

    if _jwt_secret is not None:
        return _jwt_secret

    if config.jwt_secret_key:
        _jwt_secret = config.jwt_secret_key
        return _jwt_secret

    aurora = get_aurora_client()

    result = aurora.query_one(
        "SELECT value FROM settings WHERE key = 'jwt_secret'",
        []
    )

    if result:
        _jwt_secret = result["value"]
        return _jwt_secret

    _jwt_secret = secrets.token_urlsafe(64)

    aurora.execute(
        """
        INSERT INTO settings (key, value)
        VALUES ('jwt_secret', :value)
        ON CONFLICT (key) DO UPDATE SET value = :value
        """,
        [param("value", _jwt_secret)]
    )

    return _jwt_secret


def create_access_token(
    user_id: str,
    org_id: str,
    scopes: list[str],
    client_id: str,
    expires_delta: Optional[timedelta] = None,
) -> str:
    """Create a JWT access token."""
    if expires_delta is None:
        expires_delta = timedelta(minutes=config.access_token_expire_minutes)

    now = datetime.now(timezone.utc)
    expire = now + expires_delta

    payload = {
        "sub": user_id,
        "org_id": org_id,
        "scope": " ".join(scopes),
        "client_id": client_id,
        "iat": now,
        "exp": expire,
        "token_type": "access_token",
    }

    token = jwt.encode(payload, _get_jwt_secret(), algorithm=ALGORITHM)
    return token


def create_refresh_token(
    user_id: str,
    org_id: str,
    scopes: list[str],
    client_id: str,
    expires_delta: Optional[timedelta] = None,
) -> tuple[str, str]:
    """Create a refresh token and store hash in database."""
    import hashlib

    if expires_delta is None:
        expires_delta = timedelta(days=config.refresh_token_expire_days)

    token = secrets.token_urlsafe(64)
    token_hash = hashlib.sha256(token.encode()).hexdigest()

    expire = datetime.now(timezone.utc) + expires_delta

    aurora = get_aurora_client()
    aurora.execute(
        """
        INSERT INTO oauth_refresh_tokens
            (token_hash, client_id, user_id, scope, expires_at)
        VALUES
            (:token_hash, :client_id, :user_id::uuid, :scope, :expires_at::timestamptz)
        """,
        [
            param("token_hash", token_hash),
            param("client_id", client_id),
            param("user_id", user_id, "UUID"),
            param("scope", " ".join(scopes)),
            param("expires_at", expire.isoformat()),
        ]
    )

    return token, token_hash


def verify_token(token: str) -> dict[str, Any]:
    """Verify and decode an access token."""
    try:
        payload = jwt.decode(
            token,
            _get_jwt_secret(),
            algorithms=[ALGORITHM],
            options={"verify_aud": False}
        )

        if payload.get("token_type") != "access_token":
            raise JWTError("Invalid token type")

        return payload

    except JWTError as e:
        logger.warning(f"Token verification failed: {e}")
        raise


def verify_refresh_token(token: str) -> Optional[dict[str, Any]]:
    """Verify a refresh token and return associated data."""
    import hashlib

    token_hash = hashlib.sha256(token.encode()).hexdigest()

    aurora = get_aurora_client()
    result = aurora.query_one(
        """
        SELECT rt.user_id, rt.client_id, rt.scope, u.organization_id as org_id
        FROM oauth_refresh_tokens rt
        JOIN users u ON rt.user_id = u.id
        WHERE rt.token_hash = :token_hash
          AND rt.expires_at > NOW()
          AND rt.revoked_at IS NULL
        """,
        [param("token_hash", token_hash)]
    )

    if not result:
        return None

    return {
        "user_id": result["user_id"],
        "org_id": result["org_id"],
        "scopes": result["scope"].split(),
        "client_id": result["client_id"],
    }


def revoke_refresh_token(token: str) -> bool:
    """Revoke a refresh token."""
    import hashlib

    token_hash = hashlib.sha256(token.encode()).hexdigest()

    aurora = get_aurora_client()
    aurora.execute(
        """
        UPDATE oauth_refresh_tokens
        SET revoked_at = NOW()
        WHERE token_hash = :token_hash
        """,
        [param("token_hash", token_hash)]
    )

    return True


def get_token_claims(authorization_header: str) -> dict[str, Any]:
    """Extract and verify token from Authorization header."""
    if not authorization_header:
        raise ValueError("Missing Authorization header")

    parts = authorization_header.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise ValueError("Invalid Authorization header format")

    return verify_token(parts[1])
