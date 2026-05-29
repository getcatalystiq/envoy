import {
  signAccessToken,
  verifyCodeChallenge,
  extractClientCredentials,
  oauthError,
  ACCESS_TOKEN_EXPIRE_SECONDS,
  REFRESH_TOKEN_EXPIRE_DAYS,
} from "@/lib/oauth";
import {
  exchangeCode,
  getClient,
  verifyClientSecret,
  getUserById,
  createRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
} from "@/lib/queries/oauth";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

export async function POST(request: Request) {
  // Throttle per IP to blunt brute force against codes / refresh tokens.
  const ipLimit = await checkRateLimit(`oauth_token_ip:${clientIp(request)}`, 60, 60);
  if (!ipLimit.allowed) {
    return oauthError(
      "invalid_request",
      "Too many requests. Please retry shortly.",
      429,
    );
  }

  const formData = await request.formData();
  const grantType = formData.get("grant_type") as string;
  const body: Record<string, string> = {};
  formData.forEach((value, key) => {
    body[key] = value as string;
  });

  const { clientId, clientSecret } = extractClientCredentials(request, body);

  if (grantType === "authorization_code") {
    return handleAuthorizationCodeGrant(
      body.code,
      body.redirect_uri,
      body.code_verifier,
      clientId || "",
      clientSecret
    );
  } else if (grantType === "refresh_token") {
    return handleRefreshTokenGrant(
      body.refresh_token,
      clientId || "",
      clientSecret
    );
  } else {
    return oauthError(
      "unsupported_grant_type",
      `Grant type '${grantType}' is not supported`
    );
  }
}

async function handleAuthorizationCodeGrant(
  code: string | undefined,
  redirectUri: string | undefined,
  codeVerifier: string | undefined,
  clientId: string,
  clientSecret: string | null
): Promise<Response> {
  if (!code) {
    return oauthError("invalid_request", "code is required");
  }
  if (!codeVerifier) {
    return oauthError(
      "invalid_request",
      "code_verifier is required (PKCE)"
    );
  }

  const authCode = await exchangeCode(code);
  if (!authCode) {
    return oauthError(
      "invalid_grant",
      "Invalid or expired authorization code"
    );
  }

  if (authCode.client_id !== clientId) {
    return oauthError("invalid_grant", "Client ID mismatch");
  }

  if (redirectUri && authCode.redirect_uri !== redirectUri) {
    return oauthError("invalid_grant", "Redirect URI mismatch");
  }

  if (
    !verifyCodeChallenge(
      codeVerifier,
      authCode.code_challenge
    )
  ) {
    return oauthError("invalid_grant", "Invalid code_verifier");
  }

  const client = await getClient(clientId);
  if (client && client.client_secret_hash) {
    if (!clientSecret || !(await verifyClientSecret(clientId, clientSecret))) {
      return oauthError("invalid_client", "Invalid client credentials", 401);
    }
  }

  const user = await getUserById(String(authCode.user_id));
  if (!user) {
    return oauthError("invalid_grant", "User not found");
  }

  const scopes = (authCode.scope as string).split(" ");

  const accessToken = await signAccessToken({
    userId: user.id,
    tenantId: user.organization_id,
    scope: scopes.join(" "),
    clientId,
  });

  const { token: refreshTokenValue } = await createRefreshToken(
    clientId,
    user.id,
    authCode.scope,
    REFRESH_TOKEN_EXPIRE_DAYS
  );

  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_EXPIRE_SECONDS,
      refresh_token: refreshTokenValue,
      scope: authCode.scope,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    }
  );
}

async function handleRefreshTokenGrant(
  refreshToken: string | undefined,
  clientId: string,
  clientSecret: string | null
): Promise<Response> {
  if (!refreshToken) {
    return oauthError("invalid_request", "refresh_token is required");
  }

  const tokenData = await verifyRefreshToken(refreshToken);
  if (!tokenData) {
    return oauthError(
      "invalid_grant",
      "Invalid or expired refresh token"
    );
  }

  if (tokenData.client_id !== clientId) {
    return oauthError("invalid_grant", "Client ID mismatch");
  }

  const client = await getClient(clientId);
  if (client && client.client_secret_hash) {
    if (!clientSecret || !(await verifyClientSecret(clientId, clientSecret))) {
      return oauthError("invalid_client", "Invalid client credentials", 401);
    }
  }

  await revokeRefreshToken(refreshToken);

  // Re-derive scopes as the intersection of what this token was granted and the
  // user's CURRENT scopes, so a privilege downgrade takes effect on refresh
  // rather than the token retaining its original (possibly elevated) scopes.
  // verifyRefreshToken already rejected deactivated users.
  const currentScopes = tokenData.user_scopes as string[];
  const effectiveScopes = tokenData.scopes.filter((s: string) =>
    currentScopes.includes(s)
  );
  if (effectiveScopes.length === 0) {
    return oauthError(
      "invalid_grant",
      "User no longer holds any of the token's scopes"
    );
  }
  const scopeString = effectiveScopes.join(" ");

  const accessToken = await signAccessToken({
    userId: tokenData.user_id,
    tenantId: tokenData.org_id,
    scope: scopeString,
    clientId,
  });

  const { token: newRefreshToken } = await createRefreshToken(
    clientId,
    tokenData.user_id,
    scopeString,
    REFRESH_TOKEN_EXPIRE_DAYS
  );

  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_EXPIRE_SECONDS,
      refresh_token: newRefreshToken,
      scope: scopeString,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    }
  );
}
