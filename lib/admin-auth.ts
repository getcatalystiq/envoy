import { extractBearerToken, verifyAccessToken } from "@/lib/oauth";
import { jsonResponse } from "@/lib/utils";

export type AuthContext = {
  userId: string;
  tenantId: string;
  scope: string;
};

export async function requireAdmin(
  request: Request
): Promise<AuthContext | Response> {
  const token = extractBearerToken(request);
  if (!token) {
    return jsonResponse({ error: "Bearer token required" }, 401);
  }

  try {
    const payload = await verifyAccessToken(token);
    const scopes = payload.scope.split(" ");
    if (!scopes.includes("admin") && !scopes.includes("write")) {
      return jsonResponse(
        { error: "Admin or write scope required" },
        403
      );
    }
    return {
      userId: payload.sub,
      tenantId: payload.tenant_id,
      scope: payload.scope,
    };
  } catch {
    return jsonResponse({ error: "Invalid or expired token" }, 401);
  }
}

export function isErrorResponse(
  result: AuthContext | Response
): result is Response {
  return result instanceof Response;
}
