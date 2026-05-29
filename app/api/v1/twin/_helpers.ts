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
 *  - TwinError 401 is remapped to 502 (see below) so a rejected TWIN_API_KEY
 *    never masquerades as an expired admin session
 *  - other TwinError statuses surfaced as-is (clamped to 4xx/5xx)
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
      // A 401 from Twin means OUR credential to Twin (TWIN_API_KEY / per-org
      // key) was rejected — a server-side config problem, not the client's
      // session expiring. If we passed 401 through, the admin UI's api client
      // would treat it as an expired access token, fire a token refresh, retry,
      // get 401 again, and eventually log the user out — an infinite loop over
      // a backend misconfiguration. Remap to 502 so it reads as an upstream
      // (gateway) failure the UI surfaces instead of a session expiry.
      if (err.status === 401) {
        return jsonResponse(
          {
            error: "Twin authentication failed",
            detail:
              err.detail ??
              "Envoy's Twin API key was rejected (401). Check TWIN_API_KEY or the per-organization key.",
          },
          502,
        );
      }
      const status =
        err.status >= 400 && err.status < 600 ? err.status : 503;
      return jsonResponse({ error: err.message, detail: err.detail }, status);
    }
    throw err;
  }
}
