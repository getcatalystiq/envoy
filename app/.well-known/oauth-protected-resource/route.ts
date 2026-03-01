import { ISSUER } from "@/lib/oauth";

export async function GET() {
  const issuer = ISSUER();

  const metadata = {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: ["read", "write", "admin"],
    resource_documentation: "https://docs.envoy.ai/chatgpt",
  };

  return new Response(JSON.stringify(metadata), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
  });
}
