import { revokeRefreshToken } from "@/lib/queries/oauth";
import { readRefreshCookie, buildClearRefreshCookie, jsonWithCookie } from "@/lib/session-cookie";

/**
 * First-party session logout: revoke the refresh token server-side and clear the
 * httpOnly cookie. Idempotent — always clears the cookie even if revocation
 * fails or no session exists.
 */
export async function POST(request: Request) {
  const refreshToken = readRefreshCookie(request);
  if (refreshToken) {
    await revokeRefreshToken(refreshToken).catch(() => {});
  }
  return jsonWithCookie({ ok: true }, 200, buildClearRefreshCookie());
}
