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

export async function POST(request: Request) {
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

  const accessToken = await signAccessToken({
    userId: tokenData.user_id,
    tenantId: tokenData.org_id,
    scope: tokenData.scopes.join(" "),
    clientId,
  });

  const { token: newRefreshToken } = await createRefreshToken(
    clientId,
    tokenData.user_id,
    tokenData.scopes.join(" "),
    REFRESH_TOKEN_EXPIRE_DAYS
  );

  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_EXPIRE_SECONDS,
      refresh_token: newRefreshToken,
      scope: tokenData.scopes.join(" "),
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
