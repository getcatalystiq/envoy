import { requireAdmin, isErrorResponse, type AuthContext } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import { getAgentConfig } from "@/lib/queries/organization";
import { AgentError } from "@/lib/agent-session";

export interface AgentRouteContext {
  agentId: string;
  environmentId: string;
  vaultIds: string[];
  tenantId: string;
  auth: AuthContext;
}

/**
 * Auth + agent resolution wrapper for the Managed Agents routes (replaces
 * `withTwinAgent`).
 *  - 401/403 from requireAdmin pass through
 *  - 503 if the org has no agent configured (`getAgentConfig` returns null when
 *    `agent_id` OR the resolved `environment_id` is missing)
 *  - AgentError 401/403 (upstream Anthropic auth) is remapped to 502 so a
 *    rejected `ANTHROPIC_API_KEY` never masquerades as an expired admin session
 *    and triggers the frontend logout loop
 *  - other AgentError statuses surfaced as-is (clamped to 4xx/5xx)
 *
 * `auth` is kept in the context — the instructions PUT route needs
 * `auth.userId`/`auth.tenantId` to write the audit row.
 */
export async function withAgent(
  request: Request,
  fn: (ctx: AgentRouteContext) => Promise<Response>,
): Promise<Response> {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const config = await getAgentConfig(auth.tenantId);
  if (!config) {
    return jsonResponse({ error: "Organization not configured for AI agent" }, 503);
  }

  try {
    return await fn({
      agentId: config.agentId,
      environmentId: config.environmentId,
      vaultIds: config.vaultIds,
      tenantId: auth.tenantId,
      auth,
    });
  } catch (err) {
    if (err instanceof AgentError) {
      const status =
        err.status === 401 || err.status === 403
          ? 502
          : err.status >= 400 && err.status < 600
            ? err.status
            : 503;
      return jsonResponse({ error: err.message, detail: err.detail }, status);
    }
    throw err;
  }
}
