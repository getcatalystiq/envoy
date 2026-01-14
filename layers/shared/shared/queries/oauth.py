"""OAuth-related database queries."""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import asyncpg
import bcrypt


class OAuthClientQueries:
    """Database queries for OAuth clients."""

    @staticmethod
    async def create(
        conn: asyncpg.Connection,
        client_name: str,
        redirect_uris: list[str],
        grant_types: Optional[list[str]] = None,
        response_types: Optional[list[str]] = None,
        token_endpoint_auth_method: str = "client_secret_basic",
        client_uri: Optional[str] = None,
        scope: Optional[str] = None,
        org_id: Optional[str] = None,
        client_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        Register a new OAuth client (Dynamic Client Registration).

        Returns:
            Client registration response with client_id and client_secret
        """
        if not client_name:
            raise ValueError("client_name is required")

        if not redirect_uris:
            raise ValueError("redirect_uris is required")

        # Validate redirect URIs
        for uri in redirect_uris:
            if not uri.startswith("https://") and not uri.startswith("http://localhost"):
                if not uri.startswith("http://127.0.0.1"):
                    raise ValueError(f"Invalid redirect_uri: {uri}. Must use HTTPS or localhost.")

        grant_types = grant_types or ["authorization_code", "refresh_token"]
        response_types = response_types or ["code"]
        scope = scope or "read write"

        supported_grant_types = ["authorization_code", "refresh_token"]
        supported_response_types = ["code"]
        supported_auth_methods = ["client_secret_basic", "client_secret_post", "none"]

        for gt in grant_types:
            if gt not in supported_grant_types:
                raise ValueError(f"Unsupported grant_type: {gt}")

        for rt in response_types:
            if rt not in supported_response_types:
                raise ValueError(f"Unsupported response_type: {rt}")

        if token_endpoint_auth_method not in supported_auth_methods:
            raise ValueError(f"Unsupported token_endpoint_auth_method: {token_endpoint_auth_method}")

        if not client_id:
            client_id = f"envoy_{secrets.token_urlsafe(16)}"

        client_secret = None
        client_secret_hash = None
        if token_endpoint_auth_method != "none":
            client_secret = secrets.token_urlsafe(32)
            client_secret_hash = bcrypt.hashpw(
                client_secret.encode(), bcrypt.gensalt()
            ).decode()

        await conn.execute(
            """
            INSERT INTO oauth_clients
                (client_id, client_secret_hash, client_name, client_uri,
                 redirect_uris, grant_types, response_types,
                 token_endpoint_auth_method, scope, organization_id)
            VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid)
            """,
            client_id,
            client_secret_hash,
            client_name,
            client_uri,
            redirect_uris,
            grant_types,
            response_types,
            token_endpoint_auth_method,
            scope,
            org_id,
        )

        response = {
            "client_id": client_id,
            "client_name": client_name,
            "redirect_uris": redirect_uris,
            "grant_types": grant_types,
            "response_types": response_types,
            "token_endpoint_auth_method": token_endpoint_auth_method,
            "scope": scope,
        }

        if client_secret:
            response["client_secret"] = client_secret
            response["client_secret_expires_at"] = 0

        if client_uri:
            response["client_uri"] = client_uri

        return response

    @staticmethod
    async def get_by_client_id(
        conn: asyncpg.Connection,
        client_id: str,
    ) -> Optional[dict[str, Any]]:
        """Get OAuth client by client_id."""
        row = await conn.fetchrow(
            """
            SELECT client_id, client_secret_hash, client_name, client_uri,
                   redirect_uris, grant_types, response_types,
                   token_endpoint_auth_method, scope, organization_id, is_active
            FROM oauth_clients
            WHERE client_id = $1
            """,
            client_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def verify_secret(
        conn: asyncpg.Connection,
        client_id: str,
        client_secret: str,
    ) -> bool:
        """Verify client credentials."""
        client = await OAuthClientQueries.get_by_client_id(conn, client_id)

        if not client:
            return False

        if not client.get("is_active", True):
            return False

        if not client.get("client_secret_hash"):
            return False

        try:
            return bcrypt.checkpw(
                client_secret.encode(),
                client["client_secret_hash"].encode()
            )
        except Exception:
            return False

    @staticmethod
    async def validate_redirect_uri(
        conn: asyncpg.Connection,
        client_id: str,
        redirect_uri: str,
    ) -> bool:
        """Validate that a redirect URI is registered for the client."""
        client = await OAuthClientQueries.get_by_client_id(conn, client_id)

        if not client:
            return False

        redirect_uris = client.get("redirect_uris", [])
        return redirect_uri in redirect_uris


class OAuthAuthorizationCodeQueries:
    """Database queries for OAuth authorization codes."""

    @staticmethod
    async def create(
        conn: asyncpg.Connection,
        code: str,
        client_id: str,
        user_id: str,
        redirect_uri: str,
        scope: str,
        code_challenge: str,
        code_challenge_method: str,
        expires_minutes: int = 10,
    ) -> None:
        """Store a new authorization code."""
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=expires_minutes)

        await conn.execute(
            """
            INSERT INTO oauth_authorization_codes
                (code, client_id, user_id, redirect_uri, scope,
                 code_challenge, code_challenge_method, expires_at)
            VALUES
                ($1, $2, $3::uuid, $4, $5, $6, $7, $8)
            """,
            code,
            client_id,
            user_id,
            redirect_uri,
            scope,
            code_challenge,
            code_challenge_method,
            expires_at,
        )

    @staticmethod
    async def get_and_validate(
        conn: asyncpg.Connection,
        code: str,
    ) -> Optional[dict[str, Any]]:
        """
        Get authorization code and validate it hasn't expired or been used.

        Returns:
            Authorization code data if valid, None otherwise
        """
        row = await conn.fetchrow(
            """
            SELECT code, client_id, user_id, redirect_uri, scope,
                   code_challenge, code_challenge_method, expires_at, used_at
            FROM oauth_authorization_codes
            WHERE code = $1
            """,
            code,
        )

        if not row:
            return None

        auth_code = dict(row)

        # Check if expired
        expires_at = auth_code["expires_at"]
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at < datetime.now(timezone.utc):
            return None

        # Check if already used
        if auth_code.get("used_at"):
            return None

        return auth_code

    @staticmethod
    async def mark_used(
        conn: asyncpg.Connection,
        code: str,
    ) -> None:
        """Mark an authorization code as used."""
        await conn.execute(
            "UPDATE oauth_authorization_codes SET used_at = NOW() WHERE code = $1",
            code,
        )

    @staticmethod
    async def cleanup_expired(
        conn: asyncpg.Connection,
    ) -> int:
        """Delete expired authorization codes."""
        result = await conn.execute(
            "DELETE FROM oauth_authorization_codes WHERE expires_at < NOW()"
        )
        # Extract count from result string like "DELETE 5"
        try:
            return int(result.split()[-1])
        except (ValueError, IndexError):
            return 0


class OAuthRefreshTokenQueries:
    """Database queries for OAuth refresh tokens."""

    @staticmethod
    async def create(
        conn: asyncpg.Connection,
        client_id: str,
        user_id: str,
        scope: str,
        expires_days: int = 30,
    ) -> tuple[str, str]:
        """
        Create and store a refresh token.

        Returns:
            Tuple of (token, token_hash)
        """
        token = secrets.token_urlsafe(64)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        expires_at = datetime.now(timezone.utc) + timedelta(days=expires_days)

        await conn.execute(
            """
            INSERT INTO oauth_refresh_tokens
                (token_hash, client_id, user_id, scope, expires_at)
            VALUES
                ($1, $2, $3::uuid, $4, $5)
            """,
            token_hash,
            client_id,
            user_id,
            scope,
            expires_at,
        )

        return token, token_hash

    @staticmethod
    async def verify(
        conn: asyncpg.Connection,
        token: str,
    ) -> Optional[dict[str, Any]]:
        """
        Verify a refresh token and return associated data.

        Returns:
            Token data if valid, None otherwise
        """
        token_hash = hashlib.sha256(token.encode()).hexdigest()

        row = await conn.fetchrow(
            """
            SELECT rt.user_id, rt.client_id, rt.scope, u.organization_id as org_id
            FROM oauth_refresh_tokens rt
            JOIN users u ON rt.user_id = u.id
            WHERE rt.token_hash = $1
              AND rt.expires_at > NOW()
              AND rt.revoked_at IS NULL
            """,
            token_hash,
        )

        if not row:
            return None

        return {
            "user_id": str(row["user_id"]),
            "org_id": str(row["org_id"]),
            "scopes": row["scope"].split(),
            "client_id": row["client_id"],
        }

    @staticmethod
    async def revoke(
        conn: asyncpg.Connection,
        token: str,
    ) -> bool:
        """Revoke a refresh token."""
        token_hash = hashlib.sha256(token.encode()).hexdigest()

        await conn.execute(
            """
            UPDATE oauth_refresh_tokens
            SET revoked_at = NOW()
            WHERE token_hash = $1
            """,
            token_hash,
        )

        return True

    @staticmethod
    async def revoke_all_for_user(
        conn: asyncpg.Connection,
        user_id: str,
    ) -> int:
        """Revoke all refresh tokens for a user."""
        result = await conn.execute(
            """
            UPDATE oauth_refresh_tokens
            SET revoked_at = NOW()
            WHERE user_id = $1::uuid AND revoked_at IS NULL
            """,
            user_id,
        )
        # Extract count from result string like "UPDATE 5"
        try:
            return int(result.split()[-1])
        except (ValueError, IndexError):
            return 0


class OAuthUserQueries:
    """Database queries for OAuth user operations."""

    @staticmethod
    async def get_by_id(
        conn: asyncpg.Connection,
        user_id: str,
    ) -> Optional[dict[str, Any]]:
        """Get user by ID."""
        row = await conn.fetchrow(
            """
            SELECT u.id, u.organization_id, u.email, u.first_name, u.last_name,
                   u.role, u.scopes, u.status, u.created_at, o.name as org_name
            FROM users u
            JOIN organizations o ON u.organization_id = o.id
            WHERE u.id = $1::uuid
            """,
            user_id,
        )

        if not row:
            return None

        return {
            "id": str(row["id"]),
            "organization_id": str(row["organization_id"]),
            "email": row["email"],
            "first_name": row["first_name"],
            "last_name": row["last_name"],
            "role": row["role"],
            "scopes": row["scopes"] or ["read", "write"],
            "status": row["status"],
            "created_at": row["created_at"],
            "org_name": row["org_name"],
        }

    @staticmethod
    async def authenticate(
        conn: asyncpg.Connection,
        email: str,
        password: str,
    ) -> Optional[dict[str, Any]]:
        """
        Authenticate a user by email and password.

        Returns:
            User data if authenticated, None otherwise
        """
        row = await conn.fetchrow(
            """
            SELECT u.id, u.organization_id, u.email, u.password_hash, u.first_name,
                   u.last_name, u.role, u.scopes, u.status, o.name as org_name
            FROM users u
            JOIN organizations o ON u.organization_id = o.id
            WHERE u.email = $1
            """,
            email,
        )

        if not row:
            return None

        if row["status"] != "active":
            return None

        try:
            if not bcrypt.checkpw(password.encode(), row["password_hash"].encode()):
                return None
        except Exception:
            return None

        # Update last login
        await conn.execute(
            "UPDATE users SET last_login_at = NOW() WHERE id = $1",
            row["id"],
        )

        return {
            "id": str(row["id"]),
            "organization_id": str(row["organization_id"]),
            "email": row["email"],
            "first_name": row["first_name"],
            "last_name": row["last_name"],
            "role": row["role"],
            "scopes": row["scopes"] or ["read", "write"],
            "org_name": row["org_name"],
        }

    @staticmethod
    async def create_organization(
        conn: asyncpg.Connection,
        name: str,
    ) -> dict[str, Any]:
        """Create a new organization."""
        if not name:
            raise ValueError("name is required")

        # Check if org already exists
        existing = await conn.fetchrow(
            "SELECT id FROM organizations WHERE name = $1",
            name,
        )
        if existing:
            raise ValueError(f"Organization with name '{name}' already exists")

        row = await conn.fetchrow(
            """
            INSERT INTO organizations (name)
            VALUES ($1)
            RETURNING id, name, created_at
            """,
            name,
        )

        return {
            "id": str(row["id"]),
            "name": row["name"],
            "created_at": row["created_at"],
        }

    @staticmethod
    async def create_user(
        conn: asyncpg.Connection,
        org_id: str,
        email: str,
        password: str,
        first_name: Optional[str] = None,
        last_name: Optional[str] = None,
        role: str = "member",
        scopes: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        """Create a new user within an organization."""
        if not email:
            raise ValueError("email is required")

        if not password or len(password) < 8:
            raise ValueError("password must be at least 8 characters")

        # Check if user already exists
        existing = await conn.fetchrow(
            "SELECT id FROM users WHERE email = $1",
            email,
        )
        if existing:
            raise ValueError(f"User with email '{email}' already exists")

        password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
        scopes = scopes or ["read", "write"]

        row = await conn.fetchrow(
            """
            INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, scopes)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
            RETURNING id, organization_id, email, first_name, last_name, role, scopes, created_at
            """,
            org_id,
            email,
            password_hash,
            first_name,
            last_name,
            role,
            scopes,
        )

        return {
            "id": str(row["id"]),
            "organization_id": str(row["organization_id"]),
            "email": row["email"],
            "first_name": row["first_name"],
            "last_name": row["last_name"],
            "role": row["role"],
            "scopes": row["scopes"],
            "created_at": row["created_at"],
        }

    @staticmethod
    async def signup(
        conn: asyncpg.Connection,
        org_name: str,
        email: str,
        password: str,
        first_name: Optional[str] = None,
        last_name: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        Self-service signup: create organization and admin user.

        Returns:
            Dict with organization and user data
        """
        org = await OAuthUserQueries.create_organization(conn, org_name)

        user = await OAuthUserQueries.create_user(
            conn,
            org_id=org["id"],
            email=email,
            password=password,
            first_name=first_name,
            last_name=last_name,
            role="admin",
            scopes=["read", "write", "admin"],
        )

        return {
            "organization": org,
            "user": user,
        }
