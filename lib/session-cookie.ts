/**
 * httpOnly refresh-token cookie for the first-party web session.
 *
 * The refresh token (30-day) lives ONLY in this cookie — never in JS-readable
 * storage — so XSS can't exfiltrate it. The short-lived access token is returned
 * in the response body and held in memory by the client. SameSite=Lax means the
 * cookie is not sent on cross-site POST/fetch, which is the CSRF defense for the
 * /api/session/* endpoints. Path is scoped to /api/session so it's never sent to
 * other routes.
 */

const COOKIE_NAME = "envoy_rt";
const COOKIE_PATH = "/api/session";

function isSecure(): boolean {
  // Secure cookies aren't sent over http; dev runs on http://localhost.
  return process.env.ENVIRONMENT !== "dev";
}

export function buildRefreshCookie(value: string, maxAgeSeconds: number): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecure()) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearRefreshCookie(): string {
  const parts = [
    `${COOKIE_NAME}=`,
    `Path=${COOKIE_PATH}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecure()) parts.push("Secure");
  return parts.join("; ");
}

export function readRefreshCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/** Build a JSON Response that also sets/clears the refresh cookie. */
export function jsonWithCookie(
  data: unknown,
  status: number,
  cookie: string,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookie,
      "Cache-Control": "no-store",
    },
  });
}
