import { createClient } from "@/lib/queries/oauth";
import { isAllowedRedirectUri } from "@/lib/oauth";
import { jsonResponse, readJsonBody } from "@/lib/utils";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

export async function POST(request: Request) {
  // Unauthenticated endpoint — throttle per IP to prevent client-table flooding.
  const ipLimit = await checkRateLimit(`oauth_register_ip:${clientIp(request)}`, 5, 300);
  if (!ipLimit.allowed) {
    return jsonResponse(
      { error: "rate_limited", error_description: "Too many registration attempts" },
      429,
    );
  }

  const parsed = await readJsonBody(request, 16_000);
  if ("error" in parsed) return parsed.error;
  const data = (parsed.data ?? {}) as Record<string, unknown>;

  const redirectUris = Array.isArray(data.redirect_uris)
    ? (data.redirect_uris as unknown[])
    : [];
  if (redirectUris.length === 0) {
    return jsonResponse(
      {
        error: "invalid_redirect_uri",
        error_description: "At least one redirect_uri is required",
      },
      400,
    );
  }

  // Dynamic Client Registration is unauthenticated, so restrict redirect URIs
  // to ALLOWED_DCR_DOMAINS (the same gate the authorize endpoint applies for
  // auto-registration). Without this, anyone could register a client pointing
  // at an attacker-controlled origin and use it for phishing.
  const allValid = redirectUris.every(
    (u) => typeof u === "string" && isAllowedRedirectUri(u),
  );
  if (!allValid) {
    return jsonResponse(
      {
        error: "invalid_redirect_uri",
        error_description: "redirect_uri not allowed for registration",
      },
      400,
    );
  }

  try {
    const result = await createClient(
      typeof data.client_name === "string" ? data.client_name : "",
      redirectUris as string[],
      {
        grantTypes: data.grant_types as string[] | undefined,
        responseTypes: data.response_types as string[] | undefined,
        tokenEndpointAuthMethod:
          (data.token_endpoint_auth_method as string | undefined) ||
          "client_secret_basic",
        clientUri: data.client_uri as string | undefined,
        scope: data.scope as string | undefined,
      },
    );

    return jsonResponse(result, 201);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Registration failed";
    return jsonResponse(
      { error: "invalid_client_metadata", error_description: message },
      400,
    );
  }
}
