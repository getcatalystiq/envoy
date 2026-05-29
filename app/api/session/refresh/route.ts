import { signAccessToken } from "@/lib/oauth";
import {
  verifyRefreshToken,
  revokeRefreshToken,
  createRefreshToken,
} from "@/lib/queries/oauth";
import { jsonResponse } from "@/lib/utils";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import {
  readRefreshCookie,
  buildRefreshCookie,
  buildClearRefreshCookie,
  jsonWithCookie,
} from "@/lib/session-cookie";

const ACCESS_TOKEN_EXPIRE_SECONDS = 86400;
const REFRESH_TOKEN_EXPIRE_DAYS = 30;

/**
 * First-party session refresh: read the refresh token from the httpOnly cookie,
 * rotate it (revoke old, issue new), set the new cookie, and return a fresh
 * access token in the body. The refresh token never touches JS.
 *
 * Mirrors the security of /api/oauth/token's refresh grant: verifyRefreshToken
 * rejects deactivated users, and the new token's scope is the intersection of
 * the granted and current user scopes.
 */
export async function POST(request: Request) {
  const ipLimit = await checkRateLimit(`session_refresh_ip:${clientIp(request)}`, 60, 60);
  if (!ipLimit.allowed) {
    return jsonResponse({ error: "rate_limited" }, 429);
  }

  const refreshToken = readRefreshCookie(request);
  if (!refreshToken) {
    return jsonResponse({ error: "no_session" }, 401);
  }

  const tokenData = await verifyRefreshToken(refreshToken);
  if (!tokenData) {
    // Invalid/expired/deactivated — clear the stale cookie.
    return jsonWithCookie({ error: "invalid_session" }, 401, buildClearRefreshCookie());
  }

  // Scope = granted ∩ current user scopes (downgrade takes effect on refresh).
  const currentScopes = tokenData.user_scopes as string[];
  const effectiveScopes = (tokenData.scopes as string[]).filter((s) =>
    currentScopes.includes(s),
  );
  if (effectiveScopes.length === 0) {
    return jsonWithCookie({ error: "invalid_session" }, 401, buildClearRefreshCookie());
  }
  const scope = effectiveScopes.join(" ");

  // Rotate.
  await revokeRefreshToken(refreshToken);
  const accessToken = await signAccessToken({
    userId: tokenData.user_id as string,
    tenantId: tokenData.org_id as string,
    scope,
    clientId: tokenData.client_id as string,
  });
  const { token: newRefreshToken } = await createRefreshToken(
    tokenData.client_id as string,
    tokenData.user_id as string,
    scope,
    REFRESH_TOKEN_EXPIRE_DAYS,
  );

  return jsonWithCookie(
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_EXPIRE_SECONDS,
      scope,
    },
    200,
    buildRefreshCookie(newRefreshToken, REFRESH_TOKEN_EXPIRE_DAYS * 86400),
  );
}
