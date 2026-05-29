import { requireAdmin, isErrorResponse, type AuthContext } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import {
  getTwinAgentId,
  resolveTwinApiKey,
} from "@/lib/queries/organization";
import { TwinError } from "@/lib/twin";

/**
 * Resolve the Twin agent ID for an organization. Re-exports the canonical
 * helper from lib/queries/organization so route handlers can import from one
 * place.
 */
export async function getAgentId(orgId: string): Promise<string | null> {
  return getTwinAgentId(orgId);
}

export interface TwinRouteContext {
  agentId: string;
  apiKey: string;
  tenantId: string;
  auth: AuthContext;
}

/**
 * Auth + agent resolution wrapper for Twin routes.
 *  - 401/403 from requireAdmin pass through
 *  - 503 if the org has no Twin agent configured
 *  - TwinError surfaced with original status (clamped to 4xx/5xx)
 *  - Other errors re-thrown for the framework
 */
export async function withTwinAgent(
  request: Request,
  fn: (ctx: TwinRouteContext) => Promise<Response>,
): Promise<Response> {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const [agentId, apiKey] = await Promise.all([
    getAgentId(auth.tenantId),
    resolveTwinApiKey(auth.tenantId),
  ]);
  if (!agentId) {
    return jsonResponse({ error: "Organization not configured for Twin" }, 503);
  }

  try {
    return await fn({ agentId, apiKey, tenantId: auth.tenantId, auth });
  } catch (err) {
    if (err instanceof TwinError) {
      const status =
        err.status >= 400 && err.status < 600 ? err.status : 503;
      return jsonResponse({ error: err.message, detail: err.detail }, status);
    }
    throw err;
  }
}
