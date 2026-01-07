"""User and organization management."""

import logging
import re
import secrets
from typing import Any, Optional

import bcrypt

from db.aurora import get_aurora_client, param

logger = logging.getLogger(__name__)


def create_organization(
    name: str,
    email: str,
    slug: Optional[str] = None,
) -> dict[str, Any]:
    """
    Create a new organization.

    Args:
        name: Organization name
        email: Admin email
        slug: URL-friendly identifier (auto-generated if not provided)

    Returns:
        Created organization data
    """
    if not name:
        raise ValueError("name is required")

    if not email:
        raise ValueError("email is required")

    if not slug:
        slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
        slug = f"{slug}-{secrets.token_hex(4)}"

    aurora = get_aurora_client()

    existing = aurora.query_one(
        "SELECT id FROM organizations WHERE name = :name",
        [param("name", name)]
    )
    if existing:
        raise ValueError(f"Organization with name '{name}' already exists")

    result = aurora.query_one(
        """
        INSERT INTO organizations (name)
        VALUES (:name)
        RETURNING id, name, created_at
        """,
        [param("name", name)]
    )

    logger.info(f"Created organization: {result['id']} ({name})")
    return result


def create_user(
    org_id: str,
    email: str,
    password: str,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
    role: str = "member",
    scopes: Optional[list[str]] = None,
) -> dict[str, Any]:
    """
    Create a new user within an organization.

    Args:
        org_id: Organization ID
        email: User email
        password: Plain text password
        first_name: First name
        last_name: Last name
        role: User role (admin, member, viewer)
        scopes: OAuth scopes (default: read, write)

    Returns:
        Created user data (without password hash)
    """
    if not email:
        raise ValueError("email is required")

    if not password or len(password) < 8:
        raise ValueError("password must be at least 8 characters")

    password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    scopes = scopes or ["read", "write"]

    aurora = get_aurora_client()

    existing = aurora.query_one(
        "SELECT id FROM users WHERE email = :email",
        [param("email", email)]
    )
    if existing:
        raise ValueError(f"User with email '{email}' already exists")

    def to_pg_array(items: list) -> str:
        escaped = [item.replace('"', '\\"') for item in items]
        return "{" + ",".join(f'"{item}"' for item in escaped) + "}"

    result = aurora.query_one(
        """
        INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, scopes)
        VALUES (:org_id::uuid, :email, :password_hash, :first_name, :last_name, :role, :scopes::text[])
        RETURNING id, organization_id, email, first_name, last_name, role, scopes, created_at
        """,
        [
            param("org_id", org_id, "UUID"),
            param("email", email),
            param("password_hash", password_hash),
            param("first_name", first_name),
            param("last_name", last_name),
            param("role", role),
            param("scopes", to_pg_array(scopes)),
        ]
    )

    logger.info(f"Created user: {result['id']} ({email}) for org {org_id}")
    return result


def authenticate_user(email: str, password: str) -> Optional[dict[str, Any]]:
    """
    Authenticate a user by email and password.

    Args:
        email: User email
        password: Plain text password

    Returns:
        User data if authenticated, None otherwise
    """
    aurora = get_aurora_client()

    user = aurora.query_one(
        """
        SELECT u.id, u.organization_id, u.email, u.password_hash, u.first_name,
               u.last_name, u.role, u.scopes, u.status, o.name as org_name
        FROM users u
        JOIN organizations o ON u.organization_id = o.id
        WHERE u.email = :email
        """,
        [param("email", email)]
    )

    if not user:
        return None

    if user.get("status") != "active":
        return None

    try:
        if not bcrypt.checkpw(password.encode(), user["password_hash"].encode()):
            return None
    except Exception:
        return None

    aurora.execute(
        "UPDATE users SET last_login_at = NOW() WHERE id = :id::uuid",
        [param("id", user["id"], "UUID")]
    )

    del user["password_hash"]
    return user


def get_user(user_id: str) -> Optional[dict[str, Any]]:
    """Get user by ID."""
    aurora = get_aurora_client()

    user = aurora.query_one(
        """
        SELECT u.id, u.organization_id, u.email, u.first_name, u.last_name,
               u.role, u.scopes, u.status, u.created_at, o.name as org_name
        FROM users u
        JOIN organizations o ON u.organization_id = o.id
        WHERE u.id = :id::uuid
        """,
        [param("id", user_id, "UUID")]
    )

    return user


def signup(
    org_name: str,
    email: str,
    password: str,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
) -> dict[str, Any]:
    """
    Self-service signup: create organization and admin user.

    Args:
        org_name: Organization name
        email: Admin email
        password: Admin password
        first_name: Admin first name
        last_name: Admin last name

    Returns:
        Dict with organization and user data
    """
    org = create_organization(name=org_name, email=email)

    user = create_user(
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
