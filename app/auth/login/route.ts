import { signAccessToken, ACCESS_TOKEN_EXPIRE_SECONDS } from "@/lib/oauth";
import { authenticateUser } from "@/lib/queries/oauth";
import { jsonResponse } from "@/lib/utils";

export async function POST(request: Request) {
  const data = await request.json();
  const { email, password } = data;

  if (!email || !password) {
    return jsonResponse({ error: "email and password are required" }, 400);
  }

  const user = await authenticateUser(email, password);
  if (!user) {
    return jsonResponse({ error: "Invalid email or password" }, 401);
  }

  const accessToken = await signAccessToken({
    userId: user.id,
    tenantId: user.organization_id,
    scope: (user.scopes || ["read", "write"]).join(" "),
    clientId: "direct_login",
  });

  return jsonResponse({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_EXPIRE_SECONDS,
    user: {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      org_id: user.organization_id,
      org_name: user.org_name,
    },
  });
}
