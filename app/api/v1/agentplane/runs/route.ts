import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as agentplane from "@/lib/agentplane";
import { getAgentId } from "../_helpers";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const agentId = await getAgentId(auth.tenantId);
  if (!agentId) {
    return jsonResponse(
      { error: "Organization not configured for AgentPlane" },
      503,
    );
  }

  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") ?? 50), 1),
    200,
  );
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
  const status = url.searchParams.get("status") ?? undefined;

  try {
    const result = await agentplane.listRuns(agentId, { limit, offset, status });
    return jsonResponse(result);
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}
