import { signAccessToken, verifyCodeChallenge } from "@/lib/oauth";
import {
  exchangeCode,
  getClient,
  getUserById,
  createRefreshToken,
} from "@/lib/queries/oauth";
import { jsonResponse, readJsonBody } from "@/lib/utils";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { buildRefreshCookie, jsonWithCookie } from "@/lib/session-cookie";

const ACCESS_TOKEN_EXPIRE_SECONDS = 86400; // mirror lib/oauth signing TTL
const REFRESH_TOKEN_EXPIRE_DAYS = 30;

/**
 * First-party session login: exchange a PKCE authorization code SERVER-SIDE and
 * set the refresh token as an httpOnly cookie. The access token is returned in
 * the body for the client to hold in memory. Used by the admin UI instead of
 * calling /api/oauth/token directly (which would expose the refresh token to JS).
 *
 * Public client only — PKCE (code_verifier) is the proof; no client_secret.
 */
export async function POST(request: Request) {
  const ipLimit = await checkRateLimit(`session_exchange_ip:${clientIp(request)}`, 30, 60);
  if (!ipLimit.allowed) {
    return jsonResponse({ error: "rate_limited" }, 429);
  }

  const parsed = await readJsonBody(request, 8_000);
  if ("error" in parsed) return parsed.error;
  const body = (parsed.data ?? {}) as Record<string, unknown>;

  const clientId = typeof body.client_id === "string" ? body.client_id : "";
  const code = typeof body.code === "string" ? body.code : "";
  const codeVerifier =
    typeof body.code_verifier === "string" ? body.code_verifier : "";
  const redirectUri =
    typeof body.redirect_uri === "string" ? body.redirect_uri : undefined;

  if (!clientId || !code || !codeVerifier) {
    return jsonResponse(
      { error: "invalid_request", error_description: "client_id, code, code_verifier required" },
      400,
    );
  }

  const authCode = await exchangeCode(code);
  if (!authCode) {
    return jsonResponse({ error: "invalid_grant", error_description: "Invalid or expired code" }, 400);
  }
  if (authCode.client_id !== clientId) {
    return jsonResponse({ error: "invalid_grant", error_description: "Client mismatch" }, 400);
  }
  if (redirectUri && authCode.redirect_uri !== redirectUri) {
    return jsonResponse({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
  }
  if (!verifyCodeChallenge(codeVerifier, authCode.code_challenge as string)) {
    return jsonResponse({ error: "invalid_grant", error_description: "Invalid code_verifier" }, 400);
  }

  // First-party session is PKCE-only. Reject if a confidential client somehow
  // reaches this endpoint (it must use /api/oauth/token with its secret).
  const client = await getClient(clientId);
  if (client && client.client_secret_hash) {
    return jsonResponse(
      { error: "invalid_client", error_description: "Confidential clients must use /api/oauth/token" },
      400,
    );
  }

  const user = await getUserById(String(authCode.user_id));
  if (!user) {
    return jsonResponse({ error: "invalid_grant", error_description: "User not found or inactive" }, 400);
  }

  const scope = authCode.scope as string;
  const accessToken = await signAccessToken({
    userId: user.id,
    tenantId: user.organization_id,
    scope,
    clientId,
  });
  const { token: refreshToken } = await createRefreshToken(
    clientId,
    user.id,
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
    buildRefreshCookie(refreshToken, REFRESH_TOKEN_EXPIRE_DAYS * 86400),
  );
}
