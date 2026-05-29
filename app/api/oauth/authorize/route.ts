import crypto from "node:crypto";
import {
  verifyCsrfToken,
  isAllowedRedirectUri,
  AUTH_CODE_EXPIRE_MINUTES,
} from "@/lib/oauth";
import {
  getClient,
  createClient,
  validateRedirectUri,
  authenticateUser,
  createAuthorizationCode,
} from "@/lib/queries/oauth";
import { renderLoginForm } from "@/lib/oauth-html";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

function tooManyAttempts(retryAfter: number): Response {
  return new Response(
    "<!DOCTYPE html><html><body style=\"font-family:sans-serif;text-align:center;padding:60px\"><h1>Too many attempts</h1><p>Please wait a minute and try again.</p></body></html>",
    {
      status: 429,
      headers: {
        "Content-Type": "text/html",
        "Retry-After": String(retryAfter),
      },
    },
  );
}

export async function GET(request: Request) {
  // The GET handler auto-registers OAuth clients (INSERT) for unknown/missing
  // client_id, so throttle per IP to prevent unauthenticated client-table
  // flooding (the same DoS the /register POST limit guards against).
  const ipLimit = await checkRateLimit(
    `oauth_authorize_get_ip:${clientIp(request)}`,
    30,
    60,
  );
  if (!ipLimit.allowed) return tooManyAttempts(ipLimit.retryAfterSeconds);

  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const responseType = url.searchParams.get("response_type");
  const scope = url.searchParams.get("scope") || "read write";
  const state = url.searchParams.get("state") || "";
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod =
    url.searchParams.get("code_challenge_method") || "S256";

  if (!redirectUri || !responseType || !codeChallenge) {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description:
          "redirect_uri, response_type, and code_challenge are required",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (responseType !== "code") {
    return new Response(
      JSON.stringify({
        error: "unsupported_response_type",
        error_description: "Only 'code' response type is supported",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // OAuth 2.1 mandates PKCE with S256; do not accept plain or unknown methods.
  if (codeChallengeMethod !== "S256") {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description: "Only S256 code_challenge_method is supported",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  let resolvedClientId = clientId;

  if (clientId) {
    const existingClient = await getClient(clientId);
    if (!existingClient) {
      if (!isAllowedRedirectUri(redirectUri)) {
        return new Response(
          JSON.stringify({
            error: "invalid_request",
            error_description:
              "redirect_uri not allowed for auto-registration",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      const result = await createClient(
        `Auto-registered: ${redirectUri.slice(0, 50)}`,
        [redirectUri],
        { tokenEndpointAuthMethod: "none", clientId }
      );
      resolvedClientId = result.client_id;
    } else {
      const valid = await validateRedirectUri(clientId, redirectUri);
      if (!valid) {
        return new Response(
          JSON.stringify({
            error: "invalid_request",
            error_description: "Invalid redirect_uri for this client",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }
  } else {
    if (!isAllowedRedirectUri(redirectUri)) {
      return new Response(
        JSON.stringify({
          error: "invalid_request",
          error_description: "redirect_uri not allowed for auto-registration",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    const result = await createClient(
      `Auto-registered: ${redirectUri.slice(0, 50)}`,
      [redirectUri],
      { tokenEndpointAuthMethod: "none" }
    );
    resolvedClientId = result.client_id;
  }

  const html = renderLoginForm({
    clientId: resolvedClientId!,
    redirectUri,
    scope,
    state,
    codeChallenge,
    codeChallengeMethod,
  });

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

export async function POST(request: Request) {
  // Throttle credential submission per IP to blunt password spraying.
  const ipLimit = await checkRateLimit(
    `oauth_authorize_ip:${clientIp(request)}`,
    10,
    60,
  );
  if (!ipLimit.allowed) return tooManyAttempts(ipLimit.retryAfterSeconds);

  const formData = await request.formData();
  const csrfToken = formData.get("csrf_token") as string;
  const clientId = formData.get("client_id") as string;
  const redirectUri = formData.get("redirect_uri") as string;
  const scope = (formData.get("scope") as string) || "read write";
  const state = (formData.get("state") as string) || "";
  const codeChallenge = formData.get("code_challenge") as string;
  const codeChallengeMethod =
    (formData.get("code_challenge_method") as string) || "S256";
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  if (!verifyCsrfToken(csrfToken)) {
    const html = renderLoginForm({
      clientId,
      redirectUri,
      scope,
      state,
      codeChallenge,
      codeChallengeMethod,
      error: "Invalid or expired form. Please try again.",
    });
    return new Response(html, {
      status: 403,
      headers: { "Content-Type": "text/html" },
    });
  }

  // Re-validate redirect_uri server-side before issuing a code — never trust the
  // round-tripped hidden form field. Without this, a tampered POST body could
  // 302 the authorization code to an attacker-controlled origin (code theft /
  // open redirect). We return a 400 (not a redirect) so a bad URI never becomes
  // a redirect target.
  const postClient = await getClient(clientId);
  const redirectAllowed = postClient
    ? await validateRedirectUri(clientId, redirectUri)
    : isAllowedRedirectUri(redirectUri);
  if (!redirectAllowed) {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description: "Invalid redirect_uri for this client",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Enforce PKCE S256 at code issuance too.
  if (codeChallengeMethod !== "S256" || !codeChallenge) {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description: "code_challenge with S256 method is required",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Throttle per account to slow targeted password guessing.
  const emailLimit = await checkRateLimit(
    `oauth_authorize_email:${(email || "").toLowerCase()}`,
    5,
    300,
  );
  if (!emailLimit.allowed) return tooManyAttempts(emailLimit.retryAfterSeconds);

  const user = await authenticateUser(email, password);
  if (!user) {
    const html = renderLoginForm({
      clientId,
      redirectUri,
      scope,
      state,
      codeChallenge,
      codeChallengeMethod,
      error: "Invalid email or password",
    });
    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });
  }

  const requestedScopes = scope.split(" ");
  const userScopes: string[] = user.scopes || [];
  let grantedScopes = requestedScopes.filter((s: string) =>
    userScopes.includes(s)
  );
  if (grantedScopes.length === 0) {
    grantedScopes = ["read"];
  }

  const code = crypto.randomBytes(32).toString("base64url");

  await createAuthorizationCode(
    code,
    clientId,
    user.id,
    redirectUri,
    grantedScopes.join(" "),
    codeChallenge,
    codeChallengeMethod,
    AUTH_CODE_EXPIRE_MINUTES
  );

  const redirectParams = new URLSearchParams({ code });
  if (state) {
    redirectParams.set("state", state);
  }

  return new Response(null, {
    status: 302,
    headers: { Location: `${redirectUri}?${redirectParams.toString()}` },
  });
}
