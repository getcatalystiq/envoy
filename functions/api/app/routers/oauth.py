"""
OAuth 2.1 endpoints for Envoy.

Implements:
- Authorization Server Metadata (RFC 8414)
- Dynamic Client Registration (RFC 7591)
- Authorization Code Grant with PKCE (RFC 7636)
- Token endpoint
- User signup/login
"""

import base64
import hashlib
import hmac
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlencode

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Form, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from shared.database import get_raw_connection
from shared.pkce import verify_code_challenge
from shared.queries.oauth import (
    OAuthAuthorizationCodeQueries,
    OAuthClientQueries,
    OAuthRefreshTokenQueries,
    OAuthUserQueries,
)

router = APIRouter()

# Configuration
ACCESS_TOKEN_EXPIRE_MINUTES = 60
REFRESH_TOKEN_EXPIRE_DAYS = 30
AUTHORIZATION_CODE_EXPIRE_MINUTES = 10
CSRF_TOKEN_EXPIRY_SECONDS = 300

# Allowed domains for automatic client registration
ALLOWED_AUTO_REGISTER_DOMAINS = [
    "claude.ai",
    "chatgpt.com",
    "chat.openai.com",
    "platform.openai.com",
    "localhost",
    "127.0.0.1",
    "d2sves47510usz.cloudfront.net",  # Envoy Admin UI (dev)
    "d38beagy3imun6.cloudfront.net",  # Envoy Admin UI (prod)
]


def _get_jwt_secret() -> str:
    """Get JWT secret for signing tokens."""
    if secret := os.environ.get("JWT_SECRET_KEY"):
        return secret
    return "dev-secret-change-in-production"


def _get_oauth_issuer(request: Request) -> str:
    """Get OAuth issuer URL from request or environment."""
    if issuer := os.environ.get("OAUTH_ISSUER"):
        return issuer
    # Derive from request
    return str(request.base_url).rstrip("/")


def _is_allowed_auto_register_uri(redirect_uri: str) -> bool:
    """Check if a redirect URI is allowed for automatic client registration."""
    from urllib.parse import urlparse
    parsed = urlparse(redirect_uri)
    hostname = parsed.hostname or ""

    for domain in ALLOWED_AUTO_REGISTER_DOMAINS:
        if hostname == domain or hostname.endswith(f".{domain}"):
            return True
    return False


def _generate_csrf_token() -> str:
    """Generate a signed CSRF token with timestamp."""
    timestamp = str(int(datetime.now(timezone.utc).timestamp()))
    random_part = secrets.token_urlsafe(16)
    data = f"{timestamp}:{random_part}"

    csrf_secret = _get_jwt_secret()
    signature = hmac.new(
        csrf_secret.encode(), data.encode(), hashlib.sha256
    ).hexdigest()[:16]

    return f"{data}:{signature}"


def _verify_csrf_token(token: str) -> bool:
    """Verify a CSRF token's signature and expiration."""
    if not token:
        return False

    parts = token.split(":")
    if len(parts) != 3:
        return False

    timestamp_str, random_part, signature = parts

    # Verify signature
    csrf_secret = _get_jwt_secret()
    data = f"{timestamp_str}:{random_part}"
    expected_signature = hmac.new(
        csrf_secret.encode(), data.encode(), hashlib.sha256
    ).hexdigest()[:16]

    if not hmac.compare_digest(signature, expected_signature):
        return False

    # Check expiration
    try:
        timestamp = int(timestamp_str)
        now = int(datetime.now(timezone.utc).timestamp())
        if now - timestamp > CSRF_TOKEN_EXPIRY_SECONDS:
            return False
    except ValueError:
        return False

    return True


def _create_access_token(
    user_id: str,
    org_id: str,
    scopes: list[str],
    client_id: str,
    role: str = "member",
    expires_delta: Optional[timedelta] = None,
) -> str:
    """Create a JWT access token."""
    import jwt

    if expires_delta is None:
        expires_delta = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)

    now = datetime.now(timezone.utc)
    expire = now + expires_delta

    payload = {
        "sub": user_id,
        "org_id": org_id,
        "scope": " ".join(scopes),
        "client_id": client_id,
        "role": role,
        "iat": now,
        "exp": expire,
        "token_type": "access_token",
    }

    return jwt.encode(payload, _get_jwt_secret(), algorithm="HS256")


def _verify_access_token(token: str) -> dict[str, Any]:
    """Verify and decode an access token."""
    import jwt

    try:
        payload = jwt.decode(
            token,
            _get_jwt_secret(),
            algorithms=["HS256"],
            options={"verify_aud": False}
        )

        if payload.get("token_type") != "access_token":
            raise ValueError("Invalid token type")

        return payload

    except jwt.ExpiredSignatureError:
        raise ValueError("Token expired")
    except jwt.InvalidTokenError as e:
        raise ValueError(f"Invalid token: {e}")


def _extract_client_credentials(
    authorization: Optional[str],
    client_id_form: Optional[str],
    client_secret_form: Optional[str],
) -> tuple[str, Optional[str]]:
    """Extract client credentials from request."""
    # Try Basic Auth first
    if authorization and authorization.lower().startswith("basic "):
        try:
            credentials = base64.b64decode(authorization[6:]).decode("utf-8")
            client_id, client_secret = credentials.split(":", 1)
            return client_id, client_secret
        except Exception:
            pass

    # Fall back to form parameters
    return client_id_form or "", client_secret_form


def _render_login_form(
    client_id: str,
    redirect_uri: str,
    scope: str,
    state: str,
    code_challenge: str,
    code_challenge_method: str,
    error: Optional[str] = None,
    csrf_token: Optional[str] = None,
) -> str:
    """Render HTML login form with CSRF protection."""
    error_html = f'<div class="error">{error}</div>' if error else ""

    if not csrf_token:
        csrf_token = _generate_csrf_token()

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
        .signup-link {{
            text-align: center;
            margin-top: 1rem;
            font-size: 0.875rem;
        }}
        .signup-link a {{
            color: #059669;
            text-decoration: none;
        }}
        .signup-link a:hover {{
            text-decoration: underline;
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
            <input type="hidden" name="csrf_token" value="{csrf_token}">
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
        <div class="signup-link">
            Don't have an account? <a href="/signup">Sign up</a>
        </div>
    </div>
</body>
</html>"""


# =============================================================================
# OAuth Endpoints
# =============================================================================

@router.get("/.well-known/oauth-authorization-server")
async def get_metadata(request: Request) -> JSONResponse:
    """Return OAuth Authorization Server Metadata (RFC 8414)."""
    issuer = _get_oauth_issuer(request)

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

    return JSONResponse(
        content=metadata,
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/.well-known/oauth-protected-resource")
async def get_protected_resource_metadata(request: Request) -> JSONResponse:
    """Return OAuth Protected Resource Metadata (RFC 9728)."""
    issuer = _get_oauth_issuer(request)

    metadata = {
        "resource": f"{issuer}/mcp",
        "authorization_servers": [issuer],
        "scopes_supported": ["read", "write", "admin"],
        "resource_documentation": "https://docs.envoy.ai/chatgpt",
    }

    return JSONResponse(
        content=metadata,
        headers={"Cache-Control": "no-cache"},
    )


@router.post("/oauth/register")
async def register_client(request: Request) -> JSONResponse:
    """Handle Dynamic Client Registration (RFC 7591)."""
    data = await request.json()

    async with get_raw_connection() as conn:
        result = await OAuthClientQueries.create(
            conn,
            client_name=data.get("client_name", ""),
            redirect_uris=data.get("redirect_uris", []),
            grant_types=data.get("grant_types"),
            response_types=data.get("response_types"),
            token_endpoint_auth_method=data.get("token_endpoint_auth_method", "client_secret_basic"),
            client_uri=data.get("client_uri"),
            scope=data.get("scope"),
        )

    return JSONResponse(content=result, status_code=201)


@router.get("/oauth/authorize", response_class=HTMLResponse)
async def authorize_get(
    request: Request,
    client_id: Optional[str] = Query(None),
    redirect_uri: str = Query(...),
    response_type: str = Query(...),
    scope: str = Query("read write"),
    state: str = Query(""),
    code_challenge: str = Query(...),
    code_challenge_method: str = Query("S256"),
) -> HTMLResponse:
    """Handle authorization GET request - returns login form."""
    if response_type != "code":
        raise HTTPException(400, "Only 'code' response type is supported")

    async with get_raw_connection() as conn:
        existing_client = None
        if client_id:
            existing_client = await OAuthClientQueries.get_by_client_id(conn, client_id)

        if not existing_client:
            if not _is_allowed_auto_register_uri(redirect_uri):
                raise HTTPException(400, "redirect_uri not allowed for auto-registration")

            # Auto-register client
            result = await OAuthClientQueries.create(
                conn,
                client_name=f"Auto-registered: {redirect_uri[:50]}",
                redirect_uris=[redirect_uri],
                token_endpoint_auth_method="none",
                client_id=client_id,
            )
            client_id = result["client_id"]
        else:
            if not await OAuthClientQueries.validate_redirect_uri(conn, client_id, redirect_uri):
                raise HTTPException(400, "Invalid redirect_uri for this client")

    html = _render_login_form(
        client_id=client_id,
        redirect_uri=redirect_uri,
        scope=scope,
        state=state,
        code_challenge=code_challenge,
        code_challenge_method=code_challenge_method,
    )

    return HTMLResponse(content=html)


@router.post("/oauth/authorize")
async def authorize_post(
    request: Request,
    csrf_token: str = Form(...),
    client_id: str = Form(...),
    redirect_uri: str = Form(...),
    scope: str = Form("read write"),
    state: str = Form(""),
    code_challenge: str = Form(...),
    code_challenge_method: str = Form("S256"),
    email: str = Form(...),
    password: str = Form(...),
) -> RedirectResponse:
    """Handle authorization POST request (login form submission)."""
    # Validate CSRF token
    if not _verify_csrf_token(csrf_token):
        html = _render_login_form(
            client_id=client_id,
            redirect_uri=redirect_uri,
            scope=scope,
            state=state,
            code_challenge=code_challenge,
            code_challenge_method=code_challenge_method,
            error="Invalid or expired form. Please try again.",
        )
        return HTMLResponse(content=html, status_code=403)

    async with get_raw_connection() as conn:
        # Authenticate user
        user = await OAuthUserQueries.authenticate(conn, email, password)
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
            return HTMLResponse(content=html)

        # Determine granted scopes
        requested_scopes = scope.split()
        user_scopes = user.get("scopes", [])
        granted_scopes = [s for s in requested_scopes if s in user_scopes]
        if not granted_scopes:
            granted_scopes = ["read"]

        # Generate authorization code
        code = secrets.token_urlsafe(32)

        # Store authorization code
        await OAuthAuthorizationCodeQueries.create(
            conn,
            code=code,
            client_id=client_id,
            user_id=user["id"],
            redirect_uri=redirect_uri,
            scope=" ".join(granted_scopes),
            code_challenge=code_challenge,
            code_challenge_method=code_challenge_method,
            expires_minutes=AUTHORIZATION_CODE_EXPIRE_MINUTES,
        )

    # Redirect with code
    redirect_params = {"code": code}
    if state:
        redirect_params["state"] = state

    redirect_url = f"{redirect_uri}?{urlencode(redirect_params)}"
    return RedirectResponse(url=redirect_url, status_code=302)


@router.post("/oauth/token")
async def token(
    request: Request,
    grant_type: str = Form(...),
    code: Optional[str] = Form(None),
    redirect_uri: Optional[str] = Form(None),
    code_verifier: Optional[str] = Form(None),
    refresh_token: Optional[str] = Form(None),
    client_id: Optional[str] = Form(None),
    client_secret: Optional[str] = Form(None),
    authorization: Optional[str] = Header(None),
) -> JSONResponse:
    """Handle token endpoint requests."""
    logger.info(f"[TOKEN] Request received - grant_type={grant_type}, has_auth_header={bool(authorization)}, form_client_id={client_id}")

    # Extract client credentials
    extracted_client_id, extracted_client_secret = _extract_client_credentials(
        authorization, client_id, client_secret
    )
    logger.info(f"[TOKEN] Extracted credentials - client_id={extracted_client_id}, has_secret={bool(extracted_client_secret)}")

    if grant_type == "authorization_code":
        return await _handle_authorization_code_grant(
            code=code,
            redirect_uri=redirect_uri,
            code_verifier=code_verifier,
            client_id=extracted_client_id,
            client_secret=extracted_client_secret,
        )
    elif grant_type == "refresh_token":
        return await _handle_refresh_token_grant(
            refresh_token=refresh_token,
            client_id=extracted_client_id,
            client_secret=extracted_client_secret,
        )
    else:
        return JSONResponse(
            content={"error": "unsupported_grant_type", "error_description": f"Grant type '{grant_type}' is not supported"},
            status_code=400,
        )


async def _handle_authorization_code_grant(
    code: Optional[str],
    redirect_uri: Optional[str],
    code_verifier: Optional[str],
    client_id: str,
    client_secret: Optional[str],
) -> JSONResponse:
    """Exchange authorization code for tokens."""
    if not code:
        return JSONResponse(
            content={"error": "invalid_request", "error_description": "code is required"},
            status_code=400,
        )

    if not code_verifier:
        return JSONResponse(
            content={"error": "invalid_request", "error_description": "code_verifier is required (PKCE)"},
            status_code=400,
        )

    async with get_raw_connection() as conn:
        # Get and validate authorization code
        auth_code = await OAuthAuthorizationCodeQueries.get_and_validate(conn, code)
        if not auth_code:
            return JSONResponse(
                content={"error": "invalid_grant", "error_description": "Invalid or expired authorization code"},
                status_code=400,
            )

        # Validate client
        if auth_code["client_id"] != client_id:
            return JSONResponse(
                content={"error": "invalid_grant", "error_description": "Client ID mismatch"},
                status_code=400,
            )

        # Validate redirect URI
        if redirect_uri and auth_code["redirect_uri"] != redirect_uri:
            return JSONResponse(
                content={"error": "invalid_grant", "error_description": "Redirect URI mismatch"},
                status_code=400,
            )

        # Verify PKCE
        if not verify_code_challenge(
            code_verifier,
            auth_code["code_challenge"],
            auth_code.get("code_challenge_method", "S256")
        ):
            return JSONResponse(
                content={"error": "invalid_grant", "error_description": "Invalid code_verifier"},
                status_code=400,
            )

        # Verify client secret if required
        client = await OAuthClientQueries.get_by_client_id(conn, client_id)
        if client and client.get("client_secret_hash"):
            if not client_secret or not await OAuthClientQueries.verify_secret(conn, client_id, client_secret):
                return JSONResponse(
                    content={"error": "invalid_client", "error_description": "Invalid client credentials"},
                    status_code=401,
                )

        # Mark code as used
        await OAuthAuthorizationCodeQueries.mark_used(conn, code)

        # Get user
        user = await OAuthUserQueries.get_by_id(conn, str(auth_code["user_id"]))
        if not user:
            return JSONResponse(
                content={"error": "invalid_grant", "error_description": "User not found"},
                status_code=400,
            )

        scopes = auth_code["scope"].split()

        # Create tokens
        access_token = _create_access_token(
            user_id=user["id"],
            org_id=user["organization_id"],
            scopes=scopes,
            client_id=client_id,
            role=user.get("role", "member"),
        )

        refresh_token_value, _ = await OAuthRefreshTokenQueries.create(
            conn,
            client_id=client_id,
            user_id=user["id"],
            scope=auth_code["scope"],
            expires_days=REFRESH_TOKEN_EXPIRE_DAYS,
        )

    return JSONResponse(
        content={
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,
            "refresh_token": refresh_token_value,
            "scope": auth_code["scope"],
        },
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


async def _handle_refresh_token_grant(
    refresh_token: Optional[str],
    client_id: str,
    client_secret: Optional[str],
) -> JSONResponse:
    """Exchange refresh token for new tokens."""
    logger.info(f"[REFRESH] Attempt started - client_id={client_id}, has_refresh_token={bool(refresh_token)}, has_client_secret={bool(client_secret)}")

    if not refresh_token:
        logger.warning("[REFRESH] Failed: No refresh token provided")
        return JSONResponse(
            content={"error": "invalid_request", "error_description": "refresh_token is required"},
            status_code=400,
        )

    # Log token hash for debugging (safe - not the actual token)
    token_hash_preview = hashlib.sha256(refresh_token.encode()).hexdigest()[:12]
    logger.info(f"[REFRESH] Token hash preview: {token_hash_preview}")

    async with get_raw_connection() as conn:
        # Verify refresh token
        token_data = await OAuthRefreshTokenQueries.verify(conn, refresh_token)
        if not token_data:
            # Check why it failed - token might exist but be expired or revoked
            full_token_hash = hashlib.sha256(refresh_token.encode()).hexdigest()
            debug_row = await conn.fetchrow(
                """
                SELECT token_hash, client_id, user_id, expires_at, revoked_at, created_at
                FROM oauth_refresh_tokens
                WHERE token_hash = $1
                """,
                full_token_hash,
            )
            if debug_row:
                logger.warning(
                    f"[REFRESH] Token found but invalid - "
                    f"expires_at={debug_row['expires_at']}, "
                    f"revoked_at={debug_row['revoked_at']}, "
                    f"created_at={debug_row['created_at']}, "
                    f"token_client_id={debug_row['client_id']}, "
                    f"request_client_id={client_id}"
                )
            else:
                logger.warning(f"[REFRESH] Token not found in database - hash={full_token_hash[:12]}...")

            return JSONResponse(
                content={"error": "invalid_grant", "error_description": "Invalid or expired refresh token"},
                status_code=400,
            )

        logger.info(f"[REFRESH] Token verified - user_id={token_data['user_id']}, token_client_id={token_data['client_id']}")

        # Validate client
        if token_data["client_id"] != client_id:
            logger.warning(f"[REFRESH] Client ID mismatch - token_client_id={token_data['client_id']}, request_client_id={client_id}")
            return JSONResponse(
                content={"error": "invalid_grant", "error_description": "Client ID mismatch"},
                status_code=400,
            )

        # Verify client secret if required
        client = await OAuthClientQueries.get_by_client_id(conn, client_id)
        if client and client.get("client_secret_hash"):
            if not client_secret or not await OAuthClientQueries.verify_secret(conn, client_id, client_secret):
                logger.warning(f"[REFRESH] Invalid client credentials for client_id={client_id}")
                return JSONResponse(
                    content={"error": "invalid_client", "error_description": "Invalid client credentials"},
                    status_code=401,
                )

        # Revoke old token
        await OAuthRefreshTokenQueries.revoke(conn, refresh_token)
        logger.info(f"[REFRESH] Old token revoked")

        # Create new tokens
        access_token = _create_access_token(
            user_id=token_data["user_id"],
            org_id=token_data["org_id"],
            scopes=token_data["scopes"],
            client_id=client_id,
            role=token_data.get("role", "member"),
        )

        new_refresh_token, _ = await OAuthRefreshTokenQueries.create(
            conn,
            client_id=client_id,
            user_id=token_data["user_id"],
            scope=" ".join(token_data["scopes"]),
            expires_days=REFRESH_TOKEN_EXPIRE_DAYS,
        )

        logger.info(f"[REFRESH] Success - new tokens created for user_id={token_data['user_id']}")

    return JSONResponse(
        content={
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,
            "refresh_token": new_refresh_token,
            "scope": " ".join(token_data["scopes"]),
        },
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@router.get("/oauth/userinfo")
async def userinfo(
    authorization: str = Header(...),
) -> JSONResponse:
    """Return user information for the authenticated user."""
    # Extract bearer token
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Invalid Authorization header")

    token = authorization[7:]

    try:
        claims = _verify_access_token(token)
    except ValueError as e:
        raise HTTPException(401, str(e))

    async with get_raw_connection() as conn:
        user = await OAuthUserQueries.get_by_id(conn, claims["sub"])
        if not user:
            raise HTTPException(404, "User not found")

    return JSONResponse(content={
        "sub": user["id"],
        "email": user["email"],
        "first_name": user.get("first_name"),
        "last_name": user.get("last_name"),
        "org_id": user["organization_id"],
        "org_name": user.get("org_name"),
        "role": user.get("role"),
        "scopes": user.get("scopes", []),
    })


def _render_signup_form(error: str = "") -> str:
    """Render HTML signup form."""
    error_html = f'<div class="error">{error}</div>' if error else ""

    return f"""<!DOCTYPE html>
<html>
<head>
    <title>Envoy - Sign Up</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f3f4f6;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
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
            margin: 0 0 1.5rem 0;
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
        .login-link {{
            text-align: center;
            margin-top: 1rem;
            font-size: 0.875rem;
        }}
        .login-link a {{
            color: #059669;
            text-decoration: none;
        }}
        .login-link a:hover {{
            text-decoration: underline;
        }}
    </style>
</head>
<body>
    <div class="container">
        <h1>Create your Envoy account</h1>
        {error_html}
        <form method="POST">
            <label for="org_name">Organization Name</label>
            <input type="text" id="org_name" name="org_name" required autofocus placeholder="Your company name">

            <label for="email">Email</label>
            <input type="email" id="email" name="email" required placeholder="you@company.com">

            <label for="first_name">First Name</label>
            <input type="text" id="first_name" name="first_name" placeholder="Optional">

            <label for="last_name">Last Name</label>
            <input type="text" id="last_name" name="last_name" placeholder="Optional">

            <label for="password">Password</label>
            <input type="password" id="password" name="password" required minlength="8" placeholder="At least 8 characters">

            <button type="submit">Create Account</button>
        </form>
        <div class="login-link">
            Already have an account? <a href="javascript:history.back()">Sign in</a>
        </div>
    </div>
</body>
</html>"""


@router.get("/signup", response_class=HTMLResponse)
async def signup_get() -> HTMLResponse:
    """Render signup form."""
    return HTMLResponse(content=_render_signup_form())


@router.post("/signup")
async def signup_post(
    request: Request,
    org_name: Optional[str] = Form(None),
    email: Optional[str] = Form(None),
    password: Optional[str] = Form(None),
    first_name: Optional[str] = Form(None),
    last_name: Optional[str] = Form(None),
) -> Response:
    """Handle self-service signup (form or JSON)."""
    # Check if this is a form submission or JSON
    content_type = request.headers.get("content-type", "")
    is_form = "form" in content_type

    if not is_form:
        # JSON API request
        data = await request.json()
        org_name = data.get("org_name", "")
        email = data.get("email", "")
        password = data.get("password", "")
        first_name = data.get("first_name")
        last_name = data.get("last_name")

    # Validation
    if not org_name:
        if is_form:
            return HTMLResponse(content=_render_signup_form("Organization name is required"))
        raise HTTPException(400, "org_name is required")
    if not email:
        if is_form:
            return HTMLResponse(content=_render_signup_form("Email is required"))
        raise HTTPException(400, "email is required")
    if not password or len(password) < 8:
        if is_form:
            return HTMLResponse(content=_render_signup_form("Password must be at least 8 characters"))
        raise HTTPException(400, "password must be at least 8 characters")

    async with get_raw_connection() as conn:
        try:
            result = await OAuthUserQueries.signup(
                conn,
                org_name=org_name,
                email=email,
                password=password,
                first_name=first_name,
                last_name=last_name,
            )
        except ValueError as e:
            if is_form:
                return HTMLResponse(content=_render_signup_form(str(e)))
            raise HTTPException(400, str(e))

    if is_form:
        # Redirect to login with success message
        return HTMLResponse(content=f"""<!DOCTYPE html>
<html>
<head>
    <title>Envoy - Account Created</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f3f4f6;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0;
        }}
        .container {{
            background: white;
            padding: 2rem;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            width: 100%;
            max-width: 400px;
            text-align: center;
        }}
        h1 {{ color: #059669; margin-bottom: 1rem; }}
        p {{ color: #666; margin-bottom: 1.5rem; }}
        a {{
            display: inline-block;
            padding: 0.75rem 1.5rem;
            background: #059669;
            color: white;
            text-decoration: none;
            border-radius: 4px;
        }}
        a:hover {{ background: #047857; }}
    </style>
</head>
<body>
    <div class="container">
        <h1>Account Created!</h1>
        <p>Welcome to Envoy, {result['user']['email']}! Your organization "{result['organization']['name']}" has been set up.</p>
        <a href="javascript:history.go(-2)">Sign In</a>
    </div>
</body>
</html>""")

    return JSONResponse(
        content={
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
        },
        status_code=201,
    )


@router.post("/login")
async def login(request: Request) -> JSONResponse:
    """Handle direct login (for testing/API access)."""
    data = await request.json()

    email = data.get("email")
    password = data.get("password")

    if not email or not password:
        raise HTTPException(400, "email and password are required")

    async with get_raw_connection() as conn:
        user = await OAuthUserQueries.authenticate(conn, email, password)
        if not user:
            raise HTTPException(401, "Invalid email or password")

    access_token = _create_access_token(
        user_id=user["id"],
        org_id=user["organization_id"],
        scopes=user.get("scopes", ["read", "write"]),
        client_id="direct_login",
        role=user.get("role", "member"),
    )

    return JSONResponse(content={
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        "user": {
            "id": user["id"],
            "email": user["email"],
            "first_name": user.get("first_name"),
            "last_name": user.get("last_name"),
            "org_id": user["organization_id"],
            "org_name": user.get("org_name"),
        },
    })
