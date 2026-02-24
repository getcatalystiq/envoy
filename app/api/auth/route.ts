import { jsonResponse } from "@/lib/utils";
import { signAccessToken } from "@/lib/oauth";
import { authenticateUser } from "@/lib/queries/oauth";

export async function POST(request: Request) {
  const body = await request.json();
  const { email, password } = body;

  if (!email || !password) {
    return jsonResponse({ error: "email and password are required" }, 400);
  }

  const user = await authenticateUser(email, password);
  if (!user) {
    return jsonResponse({ error: "Invalid email or password" }, 401);
  }

  const token = await signAccessToken({
    userId: user.id,
    tenantId: user.organization_id,
    scope: (user.scopes || ["read", "write"]).join(" "),
    clientId: "direct_login",
  });

  return jsonResponse({
    access_token: token,
    token_type: "bearer",
    user: {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role,
      organization_id: user.organization_id,
      org_name: user.org_name,
    },
  });
}
