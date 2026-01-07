"""Dynamic Client Registration (RFC 7591)."""

import logging
import secrets
from typing import Any, Optional

import bcrypt

from db.aurora import get_aurora_client, param

logger = logging.getLogger(__name__)

SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"]
SUPPORTED_RESPONSE_TYPES = ["code"]
SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS = ["client_secret_basic", "client_secret_post", "none"]


def register_client(
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

    Args:
        client_name: Human-readable client name
        redirect_uris: List of allowed redirect URIs
        grant_types: Allowed grant types
        response_types: Allowed response types
        token_endpoint_auth_method: Auth method for token endpoint
        client_uri: URL of client's homepage
        scope: Space-separated list of allowed scopes
        org_id: Optional organization ID to associate client with
        client_id: Optional client ID

    Returns:
        Client registration response with client_id and client_secret
    """
    if not client_name:
        raise ValueError("client_name is required")

    if not redirect_uris:
        raise ValueError("redirect_uris is required")

    for uri in redirect_uris:
        if not uri.startswith("https://") and not uri.startswith("http://localhost"):
            if not uri.startswith("http://127.0.0.1"):
                raise ValueError(f"Invalid redirect_uri: {uri}. Must use HTTPS or localhost.")

    grant_types = grant_types or ["authorization_code", "refresh_token"]
    response_types = response_types or ["code"]
    scope = scope or "read write"

    for gt in grant_types:
        if gt not in SUPPORTED_GRANT_TYPES:
            raise ValueError(f"Unsupported grant_type: {gt}")

    for rt in response_types:
        if rt not in SUPPORTED_RESPONSE_TYPES:
            raise ValueError(f"Unsupported response_type: {rt}")

    if token_endpoint_auth_method not in SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS:
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

    aurora = get_aurora_client()

    def to_pg_array(items: list) -> str:
        escaped = [item.replace('"', '\\"') for item in items]
        return "{" + ",".join(f'"{item}"' for item in escaped) + "}"

    aurora.execute(
        """
        INSERT INTO oauth_clients
            (client_id, client_secret_hash, client_name, client_uri,
             redirect_uris, grant_types, response_types,
             token_endpoint_auth_method, scope, organization_id)
        VALUES
            (:client_id, :client_secret_hash, :client_name, :client_uri,
             :redirect_uris::text[], :grant_types::text[], :response_types::text[],
             :token_endpoint_auth_method, :scope, :org_id::uuid)
        """,
        [
            param("client_id", client_id),
            param("client_secret_hash", client_secret_hash),
            param("client_name", client_name),
            param("client_uri", client_uri),
            param("redirect_uris", to_pg_array(redirect_uris)),
            param("grant_types", to_pg_array(grant_types)),
            param("response_types", to_pg_array(response_types)),
            param("token_endpoint_auth_method", token_endpoint_auth_method),
            param("scope", scope),
            param("org_id", org_id, "UUID" if org_id else None),
        ]
    )

    logger.info(f"Registered new OAuth client: {client_id} ({client_name})")

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


def get_client(client_id: str) -> Optional[dict[str, Any]]:
    """Get OAuth client by client_id."""
    aurora = get_aurora_client()
    return aurora.query_one(
        """
        SELECT client_id, client_secret_hash, client_name, client_uri,
               redirect_uris, grant_types, response_types,
               token_endpoint_auth_method, scope, organization_id, is_active
        FROM oauth_clients
        WHERE client_id = :client_id
        """,
        [param("client_id", client_id)]
    )


def verify_client_secret(client_id: str, client_secret: str) -> bool:
    """Verify client credentials."""
    client = get_client(client_id)

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


def validate_redirect_uri(client_id: str, redirect_uri: str) -> bool:
    """Validate that a redirect URI is registered for the client."""
    client = get_client(client_id)

    if not client:
        return False

    redirect_uris = client.get("redirect_uris", [])
    return redirect_uri in redirect_uris
