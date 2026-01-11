"""Webhook authentication utilities."""

import hmac
from uuid import UUID

from fastapi import HTTPException

from .database import get_raw_connection


async def verify_webhook_secret(
    org_id: UUID,
    provided_secret: str,
) -> bool:
    """
    Verify webhook secret matches organization's configured secret.

    Uses constant-time comparison to prevent timing attacks.

    Args:
        org_id: Organization UUID
        provided_secret: Secret provided in X-Webhook-Secret header

    Returns:
        True if valid

    Raises:
        HTTPException: 401 if webhook not configured or secret invalid
    """
    if not provided_secret:
        raise HTTPException(
            status_code=401,
            detail="Missing X-Webhook-Secret header",
        )

    async with get_raw_connection() as conn:
        result = await conn.fetchrow(
            "SELECT webhook_secret FROM organizations WHERE id = $1",
            org_id,
        )

    if not result:
        raise HTTPException(
            status_code=404,
            detail="Organization not found",
        )

    expected_secret = result["webhook_secret"]

    if not expected_secret:
        raise HTTPException(
            status_code=401,
            detail="Webhook not configured for this organization. Set webhook_secret first.",
        )

    # Constant-time comparison to prevent timing attacks
    if not hmac.compare_digest(provided_secret.encode(), expected_secret.encode()):
        raise HTTPException(
            status_code=401,
            detail="Invalid webhook secret",
        )

    return True


async def get_organization_webhook_secret(org_id: UUID) -> str | None:
    """
    Get an organization's webhook secret.

    Args:
        org_id: Organization UUID

    Returns:
        Webhook secret or None if not set
    """
    async with get_raw_connection() as conn:
        result = await conn.fetchrow(
            "SELECT webhook_secret FROM organizations WHERE id = $1",
            org_id,
        )

    if not result:
        return None

    return result["webhook_secret"]


async def set_organization_webhook_secret(org_id: UUID, secret: str) -> None:
    """
    Set an organization's webhook secret.

    Args:
        org_id: Organization UUID
        secret: New webhook secret (should be cryptographically random)
    """
    async with get_raw_connection() as conn:
        await conn.execute(
            """
            UPDATE organizations
            SET webhook_secret = $1
            WHERE id = $2
            """,
            secret,
            org_id,
        )


def generate_webhook_secret() -> str:
    """
    Generate a cryptographically secure webhook secret.

    Returns:
        64-character hex string
    """
    import secrets

    return secrets.token_hex(32)
