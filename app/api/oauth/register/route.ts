import { createClient } from "@/lib/queries/oauth";
import { jsonResponse } from "@/lib/utils";

export async function POST(request: Request) {
  const data = await request.json();

  try {
    const result = await createClient(
      data.client_name || "",
      data.redirect_uris || [],
      {
        grantTypes: data.grant_types,
        responseTypes: data.response_types,
        tokenEndpointAuthMethod:
          data.token_endpoint_auth_method || "client_secret_basic",
        clientUri: data.client_uri,
        scope: data.scope,
      }
    );

    return jsonResponse(result, 201);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Registration failed";
    return jsonResponse({ error: "invalid_client_metadata", error_description: message }, 400);
  }
}
