import crypto from "node:crypto";
import {
  generateCsrfToken,
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

export async function GET(request: Request) {
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
