"""
OAuth 2.1 Server Lambda Handler for Envoy.

Implements:
- Authorization Server Metadata (RFC 8414)
- Dynamic Client Registration (RFC 7591)
- Authorization Code Grant with PKCE (RFC 7636)
- Token endpoint
- User signup/login
"""

import base64
import json
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import parse_qs, urlencode

from utils.config import config
from db.aurora import get_aurora_client, param
from .dcr import register_client, get_client, verify_client_secret, validate_redirect_uri
from .tokens import (
    create_access_token,
    create_refresh_token,
    verify_refresh_token,
    revoke_refresh_token,
)
from .pkce import verify_code_challenge
from .users import authenticate_user, signup, get_user

logger = logging.getLogger(__name__)

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

# Allowed domains for automatic client registration
ALLOWED_AUTO_REGISTER_DOMAINS = [
    "claude.ai",
    "chatgpt.com",
    "chat.openai.com",
    "platform.openai.com",
    "localhost",
    "127.0.0.1",
    "d2sves47510usz.cloudfront.net",  # Envoy Admin UI
]


def _is_allowed_auto_register_uri(redirect_uri: str) -> bool:
    """Check if a redirect URI is allowed for automatic client registration."""
    from urllib.parse import urlparse
    parsed = urlparse(redirect_uri)
    hostname = parsed.hostname or ""

    for domain in ALLOWED_AUTO_REGISTER_DOMAINS:
        if hostname == domain or hostname.endswith(f".{domain}"):
            return True
    return False


def handler(event: dict, context: Any) -> dict:
    """Lambda handler for OAuth endpoints."""
    http_method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    raw_path = event.get("rawPath", "/")

    stage = event.get("requestContext", {}).get("stage", "")
    if stage and raw_path.startswith(f"/{stage}"):
        path = raw_path[len(f"/{stage}"):]
    else:
        path = raw_path

    logger.info(f"OAuth request: method={http_method}, raw_path={raw_path}, path={path}")

    headers = event.get("headers", {})
    query_params = event.get("queryStringParameters", {}) or {}
    body = event.get("body", "")

    if body and event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")

    body_params = {}
    if body:
        # Headers are case-insensitive - check both forms
        content_type = headers.get("content-type", "") or headers.get("Content-Type", "")
        if "application/json" in content_type.lower():
            try:
                body_params = json.loads(body)
            except json.JSONDecodeError:
                pass
        elif "application/x-www-form-urlencoded" in content_type.lower():
            body_params = {k: v[0] for k, v in parse_qs(body).items()}
        elif body.strip().startswith("{"):
            # Fallback: try parsing as JSON if body looks like JSON
            try:
                body_params = json.loads(body)
            except json.JSONDecodeError:
                pass

    try:
        if http_method == "OPTIONS":
            return {"statusCode": 204, "headers": CORS_HEADERS, "body": ""}

        if path == "/.well-known/oauth-authorization-server":
            return _handle_metadata(event)

        elif path == "/.well-known/oauth-protected-resource":
            return _handle_protected_resource_metadata(event)

        elif path == "/oauth/register" and http_method == "POST":
            return _handle_register(body_params)

        elif path in ["/oauth/authorize", "/authorize"] and http_method == "GET":
            return _handle_authorize_get(query_params)

        elif path in ["/oauth/authorize", "/authorize"] and http_method == "POST":
            return _handle_authorize_post(body_params, query_params)

        elif path in ["/oauth/token", "/token"] and http_method == "POST":
            return _handle_token(body_params, headers)

        elif path == "/oauth/userinfo" and http_method == "GET":
            return _handle_userinfo(headers)

        elif path == "/signup" and http_method == "POST":
            return _handle_signup(body_params)

        elif path == "/login" and http_method == "POST":
            return _handle_login(body_params)

        else:
            return _error_response(404, "not_found", "Endpoint not found")

    except ValueError as e:
        logger.warning(f"Validation error: {e}")
        return _error_response(400, "invalid_request", str(e))
    except Exception as e:
        logger.exception(f"OAuth error: {e}")
        return _error_response(500, "server_error", "Internal server error")


def _handle_metadata(event: dict) -> dict:
    """Return OAuth Authorization Server Metadata (RFC 8414)."""
    issuer = config.get_oauth_issuer(event)

    metadata = {
        "issuer": issuer,
        "authorization_endpoint": f"{issuer}/oauth/authorize",
        "token_endpoint": f"{issuer}/oauth/token",
        "registration_endpoint": f"{issuer}/oauth/register",
        "userinfo_endpoint": f"{issuer}/oauth/userinfo",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_methods_supported": [
            "client_secret_basic",
            "client_secret_post",
            "none"
        ],
        "scopes_supported": ["read", "write", "admin"],
        "code_challenge_methods_supported": ["S256", "plain"],
        "service_documentation": "https://envoy.app/docs",
        "ui_locales_supported": ["en"],
    }

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-cache", **CORS_HEADERS},
        "body": json.dumps(metadata),
    }


def _handle_protected_resource_metadata(event: dict) -> dict:
    """Return OAuth Protected Resource Metadata (RFC 9728)."""
    issuer = config.get_oauth_issuer(event)

    metadata = {
        "resource": f"{issuer}/mcp",
        "authorization_servers": [issuer],
        "scopes_supported": ["read", "write", "admin"],
        "resource_documentation": "https://docs.envoy.ai/chatgpt",
    }

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-cache", **CORS_HEADERS},
        "body": json.dumps(metadata),
    }


def _handle_register(params: dict) -> dict:
    """Handle Dynamic Client Registration (RFC 7591)."""
    result = register_client(
        client_name=params.get("client_name", ""),
        redirect_uris=params.get("redirect_uris", []),
        grant_types=params.get("grant_types"),
        response_types=params.get("response_types"),
        token_endpoint_auth_method=params.get("token_endpoint_auth_method", "client_secret_basic"),
        client_uri=params.get("client_uri"),
        scope=params.get("scope"),
    )

    return {
        "statusCode": 201,
        "headers": {"Content-Type": "application/json", **CORS_HEADERS},
        "body": json.dumps(result),
    }


def _handle_authorize_get(params: dict) -> dict:
    """Handle authorization GET request - returns login form."""
    client_id = params.get("client_id")
    redirect_uri = params.get("redirect_uri")
    response_type = params.get("response_type")
    scope = params.get("scope", "read write")
    state = params.get("state", "")
    code_challenge = params.get("code_challenge")
    code_challenge_method = params.get("code_challenge_method", "S256")

    if response_type != "code":
        return _error_response(400, "unsupported_response_type", "Only 'code' response type is supported")

    if not redirect_uri:
        return _error_response(400, "invalid_request", "redirect_uri is required")

    existing_client = get_client(client_id) if client_id else None
    if not existing_client:
        if not _is_allowed_auto_register_uri(redirect_uri):
            return _error_response(400, "invalid_request", "redirect_uri not allowed for auto-registration")

        try:
            result = register_client(
                client_name=f"Auto-registered: {redirect_uri[:50]}",
                redirect_uris=[redirect_uri],
                token_endpoint_auth_method="none",
                client_id=client_id,
            )
            client_id = result["client_id"]
            logger.info(f"Auto-registered client {client_id} for {redirect_uri}")
        except ValueError as e:
            return _error_response(400, "invalid_request", str(e))
    else:
        if not validate_redirect_uri(client_id, redirect_uri):
            return _error_response(400, "invalid_request", "Invalid redirect_uri for this client")

    if not code_challenge:
        return _error_response(400, "invalid_request", "code_challenge is required (PKCE)")

    html = _render_login_form(
        client_id=client_id,
        redirect_uri=redirect_uri,
        scope=scope,
        state=state,
        code_challenge=code_challenge,
        code_challenge_method=code_challenge_method,
    )

    return {"statusCode": 200, "headers": {"Content-Type": "text/html"}, "body": html}


def _handle_authorize_post(body_params: dict, query_params: dict) -> dict:
    """Handle authorization POST request (login form submission)."""
    client_id = body_params.get("client_id") or query_params.get("client_id")
    redirect_uri = body_params.get("redirect_uri") or query_params.get("redirect_uri")
    scope = body_params.get("scope") or query_params.get("scope", "read write")
    state = body_params.get("state") or query_params.get("state", "")
    code_challenge = body_params.get("code_challenge") or query_params.get("code_challenge")
    code_challenge_method = body_params.get("code_challenge_method") or query_params.get("code_challenge_method", "S256")

    email = body_params.get("email")
    password = body_params.get("password")

    if not email or not password:
        return _error_response(400, "invalid_request", "Email and password are required")

    user = authenticate_user(email, password)
    if not user:
        html = _render_login_form(
            client_id=client_id,
            redirect_uri=redirect_uri,
            scope=scope,
            state=state,
            code_challenge=code_challenge,
            code_challenge_method=code_challenge_method,
            error="Invalid email or password",
        )
        return {"statusCode": 200, "headers": {"Content-Type": "text/html"}, "body": html}

    requested_scopes = scope.split()
    user_scopes = user.get("scopes", [])
    granted_scopes = [s for s in requested_scopes if s in user_scopes]

    if not granted_scopes:
        granted_scopes = ["read"]

    code = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=config.authorization_code_expire_minutes)

    aurora = get_aurora_client()
    aurora.execute(
        """
        INSERT INTO oauth_authorization_codes
            (code, client_id, user_id, redirect_uri, scope,
             code_challenge, code_challenge_method, expires_at)
        VALUES
            (:code, :client_id, :user_id::uuid, :redirect_uri, :scope,
             :code_challenge, :code_challenge_method, :expires_at::timestamptz)
        """,
        [
            param("code", code),
            param("client_id", client_id),
            param("user_id", user["id"], "UUID"),
            param("redirect_uri", redirect_uri),
            param("scope", " ".join(granted_scopes)),
            param("code_challenge", code_challenge),
            param("code_challenge_method", code_challenge_method),
            param("expires_at", expires_at.isoformat()),
        ]
    )

    redirect_params = {"code": code}
    if state:
        redirect_params["state"] = state

    redirect_url = f"{redirect_uri}?{urlencode(redirect_params)}"
    return {"statusCode": 302, "headers": {"Location": redirect_url}, "body": ""}


def _handle_token(params: dict, headers: dict) -> dict:
    """Handle token endpoint requests."""
    grant_type = params.get("grant_type")
    client_id, client_secret = _extract_client_credentials(params, headers)

    if grant_type == "authorization_code":
        return _handle_authorization_code_grant(params, client_id, client_secret)
    elif grant_type == "refresh_token":
        return _handle_refresh_token_grant(params, client_id, client_secret)
    else:
        return _error_response(400, "unsupported_grant_type", f"Grant type '{grant_type}' is not supported")


def _handle_authorization_code_grant(params: dict, client_id: str, client_secret: Optional[str]) -> dict:
    """Exchange authorization code for tokens."""
    code = params.get("code")
    redirect_uri = params.get("redirect_uri")
    code_verifier = params.get("code_verifier")

    if not code:
        return _error_response(400, "invalid_request", "code is required")

    if not code_verifier:
        return _error_response(400, "invalid_request", "code_verifier is required (PKCE)")

    aurora = get_aurora_client()
    auth_code = aurora.query_one(
        """
        SELECT code, client_id, user_id, redirect_uri, scope,
               code_challenge, code_challenge_method, expires_at, used_at
        FROM oauth_authorization_codes
        WHERE code = :code
        """,
        [param("code", code)]
    )

    if not auth_code:
        return _error_response(400, "invalid_grant", "Invalid authorization code")

    expires_at = auth_code.get("expires_at")
    if isinstance(expires_at, str):
        expires_at = expires_at.replace("Z", "+00:00")
        if "+" not in expires_at and "-" not in expires_at[10:]:
            expires_at = expires_at + "+00:00"
        expires_at = datetime.fromisoformat(expires_at)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < datetime.now(timezone.utc):
        return _error_response(400, "invalid_grant", "Authorization code has expired")

    if auth_code.get("used_at"):
        return _error_response(400, "invalid_grant", "Authorization code has already been used")

    if auth_code["client_id"] != client_id:
        return _error_response(400, "invalid_grant", "Client ID mismatch")

    if redirect_uri and auth_code["redirect_uri"] != redirect_uri:
        return _error_response(400, "invalid_grant", "Redirect URI mismatch")

    if not verify_code_challenge(
        code_verifier,
        auth_code["code_challenge"],
        auth_code.get("code_challenge_method", "S256")
    ):
        return _error_response(400, "invalid_grant", "Invalid code_verifier")

    client = get_client(client_id)
    if client and client.get("client_secret_hash"):
        if not client_secret or not verify_client_secret(client_id, client_secret):
            return _error_response(401, "invalid_client", "Invalid client credentials")

    aurora.execute(
        "UPDATE oauth_authorization_codes SET used_at = NOW() WHERE code = :code",
        [param("code", code)]
    )

    user = get_user(auth_code["user_id"])
    if not user:
        return _error_response(400, "invalid_grant", "User not found")

    scopes = auth_code["scope"].split()

    access_token = create_access_token(
        user_id=user["id"],
        org_id=user["organization_id"],
        scopes=scopes,
        client_id=client_id,
    )

    refresh_token, _ = create_refresh_token(
        user_id=user["id"],
        org_id=user["organization_id"],
        scopes=scopes,
        client_id=client_id,
    )

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-store", "Pragma": "no-cache", **CORS_HEADERS},
        "body": json.dumps({
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": config.access_token_expire_minutes * 60,
            "refresh_token": refresh_token,
            "scope": auth_code["scope"],
        }),
    }


def _handle_refresh_token_grant(params: dict, client_id: str, client_secret: Optional[str]) -> dict:
    """Exchange refresh token for new tokens."""
    refresh_token = params.get("refresh_token")

    if not refresh_token:
        return _error_response(400, "invalid_request", "refresh_token is required")

    token_data = verify_refresh_token(refresh_token)
    if not token_data:
        return _error_response(400, "invalid_grant", "Invalid or expired refresh token")

    if token_data["client_id"] != client_id:
        return _error_response(400, "invalid_grant", "Client ID mismatch")

    client = get_client(client_id)
    if client and client.get("client_secret_hash"):
        if not client_secret or not verify_client_secret(client_id, client_secret):
            return _error_response(401, "invalid_client", "Invalid client credentials")

    revoke_refresh_token(refresh_token)

    access_token = create_access_token(
        user_id=token_data["user_id"],
        org_id=token_data["org_id"],
        scopes=token_data["scopes"],
        client_id=client_id,
    )

    new_refresh_token, _ = create_refresh_token(
        user_id=token_data["user_id"],
        org_id=token_data["org_id"],
        scopes=token_data["scopes"],
        client_id=client_id,
    )

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-store", "Pragma": "no-cache", **CORS_HEADERS},
        "body": json.dumps({
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": config.access_token_expire_minutes * 60,
            "refresh_token": new_refresh_token,
            "scope": " ".join(token_data["scopes"]),
        }),
    }


def _handle_userinfo(headers: dict) -> dict:
    """Return user information for the authenticated user."""
    from .tokens import get_token_claims

    auth_header = headers.get("authorization") or headers.get("Authorization")
    if not auth_header:
        return _error_response(401, "invalid_token", "Missing Authorization header")

    try:
        claims = get_token_claims(auth_header)
    except Exception as e:
        return _error_response(401, "invalid_token", str(e))

    user = get_user(claims["sub"])
    if not user:
        return _error_response(404, "not_found", "User not found")

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json", **CORS_HEADERS},
        "body": json.dumps({
            "sub": user["id"],
            "email": user["email"],
            "first_name": user.get("first_name"),
            "last_name": user.get("last_name"),
            "org_id": user["organization_id"],
            "org_name": user.get("org_name"),
            "role": user.get("role"),
            "scopes": user.get("scopes", []),
        }),
    }


def _handle_signup(params: dict) -> dict:
    """Handle self-service signup."""
    result = signup(
        org_name=params.get("org_name", ""),
        email=params.get("email", ""),
        password=params.get("password", ""),
        first_name=params.get("first_name"),
        last_name=params.get("last_name"),
    )

    return {
        "statusCode": 201,
        "headers": {"Content-Type": "application/json", **CORS_HEADERS},
        "body": json.dumps({
            "organization": {
                "id": result["organization"]["id"],
                "name": result["organization"]["name"],
            },
            "user": {
                "id": result["user"]["id"],
                "email": result["user"]["email"],
                "first_name": result["user"].get("first_name"),
                "last_name": result["user"].get("last_name"),
                "role": result["user"]["role"],
            },
        }),
    }


def _handle_login(params: dict) -> dict:
    """Handle direct login (for testing/API access)."""
    email = params.get("email")
    password = params.get("password")

    if not email or not password:
        return _error_response(400, "invalid_request", "email and password are required")

    user = authenticate_user(email, password)
    if not user:
        return _error_response(401, "invalid_credentials", "Invalid email or password")

    access_token = create_access_token(
        user_id=user["id"],
        org_id=user["organization_id"],
        scopes=user.get("scopes", ["read", "write"]),
        client_id="direct_login",
    )

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json", **CORS_HEADERS},
        "body": json.dumps({
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": config.access_token_expire_minutes * 60,
            "user": {
                "id": user["id"],
                "email": user["email"],
                "first_name": user.get("first_name"),
                "last_name": user.get("last_name"),
                "org_id": user["organization_id"],
                "org_name": user.get("org_name"),
            },
        }),
    }


def _extract_client_credentials(params: dict, headers: dict) -> tuple[str, Optional[str]]:
    """Extract client credentials from request."""
    auth_header = headers.get("authorization") or headers.get("Authorization", "")
    if auth_header.lower().startswith("basic "):
        try:
            credentials = base64.b64decode(auth_header[6:]).decode("utf-8")
            client_id, client_secret = credentials.split(":", 1)
            return client_id, client_secret
        except Exception:
            pass

    client_id = params.get("client_id", "")
    client_secret = params.get("client_secret")
    return client_id, client_secret


def _render_login_form(
    client_id: str,
    redirect_uri: str,
    scope: str,
    state: str,
    code_challenge: str,
    code_challenge_method: str,
    error: Optional[str] = None,
) -> str:
    """Render HTML login form."""
    error_html = f'<div class="error">{error}</div>' if error else ""

    return f"""<!DOCTYPE html>
<html>
<head>
    <title>Envoy - Sign In</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f5f5;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
        }}
        .container {{
            background: white;
            padding: 2rem;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            width: 100%;
            max-width: 400px;
        }}
        h1 {{
            margin: 0 0 1.5rem;
            font-size: 1.5rem;
            text-align: center;
            color: #059669;
        }}
        .error {{
            background: #fee;
            color: #c00;
            padding: 0.75rem;
            border-radius: 4px;
            margin-bottom: 1rem;
        }}
        label {{
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 500;
        }}
        input {{
            width: 100%;
            padding: 0.75rem;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 1rem;
            margin-bottom: 1rem;
            box-sizing: border-box;
        }}
        button {{
            width: 100%;
            padding: 0.75rem;
            background: #059669;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 1rem;
            cursor: pointer;
        }}
        button:hover {{
            background: #047857;
        }}
        .scope-info {{
            font-size: 0.875rem;
            color: #666;
            margin-bottom: 1rem;
        }}
    </style>
</head>
<body>
    <div class="container">
        <h1>Sign in to Envoy</h1>
        {error_html}
        <div class="scope-info">
            Requested access: <strong>{scope}</strong>
        </div>
        <form method="POST">
            <input type="hidden" name="client_id" value="{client_id}">
            <input type="hidden" name="redirect_uri" value="{redirect_uri}">
            <input type="hidden" name="scope" value="{scope}">
            <input type="hidden" name="state" value="{state}">
            <input type="hidden" name="code_challenge" value="{code_challenge}">
            <input type="hidden" name="code_challenge_method" value="{code_challenge_method}">

            <label for="email">Email</label>
            <input type="email" id="email" name="email" required autofocus>

            <label for="password">Password</label>
            <input type="password" id="password" name="password" required>

            <button type="submit">Sign In</button>
        </form>
    </div>
</body>
</html>"""


def _error_response(status_code: int, error: str, description: str) -> dict:
    """Return OAuth error response."""
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json", **CORS_HEADERS},
        "body": json.dumps({"error": error, "error_description": description}),
    }
