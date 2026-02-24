import { extractClientCredentials } from "@/lib/oauth";
import { revokeRefreshToken } from "@/lib/queries/oauth";

export async function POST(request: Request) {
  const formData = await request.formData();
  const body: Record<string, string> = {};
  formData.forEach((value, key) => {
    body[key] = value as string;
  });

  const token = body.token;
  const tokenTypeHint = body.token_type_hint;

  if (!token) {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description: "token is required",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Extract client credentials for validation (optional per RFC 7009)
  extractClientCredentials(request, body);

  // We only support revoking refresh tokens
  if (!tokenTypeHint || tokenTypeHint === "refresh_token") {
    await revokeRefreshToken(token);
  }

  // Per RFC 7009, always return 200 even if token was invalid
  return new Response(JSON.stringify({}), {
    headers: { "Content-Type": "application/json" },
  });
}
