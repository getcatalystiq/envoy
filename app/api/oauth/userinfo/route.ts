import { extractBearerToken, verifyAccessToken } from "@/lib/oauth";
import { getUserById } from "@/lib/queries/oauth";
import { jsonResponse } from "@/lib/utils";

export async function GET(request: Request) {
  const token = extractBearerToken(request);
  if (!token) {
    return jsonResponse({ error: "Invalid Authorization header" }, 401);
  }

  let claims;
  try {
    claims = await verifyAccessToken(token);
  } catch {
    return jsonResponse({ error: "Invalid token" }, 401);
  }

  const user = await getUserById(claims.sub);
  if (!user) {
    return jsonResponse({ error: "User not found" }, 404);
  }

  return jsonResponse({
    sub: user.id,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    org_id: user.organization_id,
    org_name: user.org_name,
    role: user.role,
    scopes: user.scopes || [],
  });
}
