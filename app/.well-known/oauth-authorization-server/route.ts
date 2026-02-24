import { ISSUER } from "@/lib/oauth";

export async function GET() {
  const issuer = ISSUER();

  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "none",
    ],
    scopes_supported: ["read", "write", "admin"],
    code_challenge_methods_supported: ["S256", "plain"],
    service_documentation: "https://envoy.app/docs",
    ui_locales_supported: ["en"],
  };

  return new Response(JSON.stringify(metadata), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
  });
}
