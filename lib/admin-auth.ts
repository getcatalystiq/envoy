import { extractBearerToken, verifyAccessToken } from "@/lib/oauth";
import { jsonResponse } from "@/lib/utils";

export type AuthContext = {
  userId: string;
  tenantId: string;
  scope: string;
};

async function authenticate(
  request: Request
): Promise<AuthContext | Response> {
  const token = extractBearerToken(request);
  if (!token) {
    return jsonResponse({ error: "Bearer token required" }, 401);
  }
  try {
    const payload = await verifyAccessToken(token);
    return {
      userId: payload.sub,
      tenantId: payload.tenant_id,
      scope: payload.scope,
    };
  } catch {
    return jsonResponse({ error: "Invalid or expired token" }, 401);
  }
}

export async function requireAdmin(
  request: Request
): Promise<AuthContext | Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const scopes = auth.scope.split(" ");
  if (!scopes.includes("admin") && !scopes.includes("write")) {
    return jsonResponse({ error: "Admin or write scope required" }, 403);
  }
  return auth;
}

// Hierarchical scope: admin ⊃ write ⊃ read. Use requireScope(request, "admin")
// to gate genuinely administrative operations (OAuth client management, etc.)
// so a merely-`write` token can't perform them.
const SCOPE_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

export async function requireScope(
  request: Request,
  scope: "read" | "write" | "admin"
): Promise<AuthContext | Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const held = Math.max(
    0,
    ...auth.scope.split(" ").map((s) => SCOPE_RANK[s] ?? 0)
  );
  if (held < SCOPE_RANK[scope]) {
    return jsonResponse({ error: `${scope} scope required` }, 403);
  }
  return auth;
}

export function isErrorResponse(
  result: AuthContext | Response
): result is Response {
  return result instanceof Response;
}
