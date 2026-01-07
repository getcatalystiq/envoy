"""JWT authentication utilities."""

import os
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from shared.database import get_raw_connection

security = HTTPBearer()

# JWT settings
JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY", "dev-secret-change-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_HOURS = 24


class AuthError(HTTPException):
    """Authentication error."""

    def __init__(self, detail: str, status_code: int = 401):
        super().__init__(status_code=status_code, detail=detail)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against its hash."""
    return bcrypt.checkpw(
        plain_password.encode("utf-8"),
        hashed_password.encode("utf-8"),
    )


def hash_password(password: str) -> str:
    """Hash a password."""
    return bcrypt.hashpw(
        password.encode("utf-8"),
        bcrypt.gensalt(),
    ).decode("utf-8")


def create_access_token(
    user_id: str,
    email: str,
    org_id: str,
    role: str,
    expires_delta: Optional[timedelta] = None,
) -> str:
    """Create a JWT access token."""
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRATION_HOURS)

    payload = {
        "sub": user_id,
        "email": email,
        "org_id": org_id,
        "role": role,
        "exp": expire,
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


async def authenticate_user(email: str, password: str) -> Optional[dict]:
    """Authenticate user by email and password."""
    async with get_raw_connection() as conn:
        user = await conn.fetchrow(
            """
            SELECT u.id, u.email, u.password_hash, u.first_name, u.last_name,
                   u.role, u.status, u.organization_id, o.name as org_name
            FROM users u
            JOIN organizations o ON o.id = u.organization_id
            WHERE u.email = $1 AND u.status = 'active'
            """,
            email,
        )

        if not user:
            return None

        if not verify_password(password, user["password_hash"]):
            return None

        # Update last login
        await conn.execute(
            "UPDATE users SET last_login_at = NOW() WHERE id = $1",
            user["id"],
        )

        return {
            "id": str(user["id"]),
            "email": user["email"],
            "first_name": user["first_name"],
            "last_name": user["last_name"],
            "role": user["role"],
            "organization_id": str(user["organization_id"]),
            "org_name": user["org_name"],
        }


async def verify_jwt(
    credentials: HTTPAuthorizationCredentials = Security(security),
) -> dict[str, Any]:
    """Validate JWT and return claims."""
    try:
        # Try RS256 first (for external tokens), then HS256 (for our tokens)
        public_key = os.environ.get("JWT_PUBLIC_KEY", "")
        if public_key and public_key != "placeholder":
            payload = jwt.decode(
                credentials.credentials,
                key=public_key,
                algorithms=["RS256"],
                audience=os.environ.get("JWT_AUDIENCE", "envoy-api"),
                issuer=os.environ.get("JWT_ISSUER", ""),
            )
        else:
            # Use HS256 for our own tokens
            payload = jwt.decode(
                credentials.credentials,
                key=JWT_SECRET_KEY,
                algorithms=[JWT_ALGORITHM],
            )
        return payload
    except jwt.ExpiredSignatureError:
        raise AuthError("Token expired")
    except jwt.InvalidTokenError as e:
        raise AuthError(f"Invalid token: {e}")


async def get_current_org(
    token: dict[str, Any] = Depends(verify_jwt),
) -> str:
    """Extract organization_id from JWT claims."""
    org_id = token.get("org_id")
    if not org_id:
        raise AuthError("No organization context", status_code=403)
    return org_id


async def get_current_user(
    token: dict[str, Any] = Depends(verify_jwt),
) -> dict[str, Any]:
    """Extract user info from JWT claims."""
    return {
        "user_id": token.get("sub"),
        "email": token.get("email"),
        "org_id": token.get("org_id"),
        "role": token.get("role"),
    }
