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

  try {
    const agent = await agentplane.getAgent(agentId);
    return jsonResponse(agent);
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const agentId = await getAgentId(auth.tenantId);
  if (!agentId) {
    return jsonResponse(
      { error: "Organization not configured for AgentPlane" },
      503,
    );
  }

  try {
    const body = await request.json();
    const updated = await agentplane.updateAgent(agentId, body);
    return jsonResponse(updated);
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}
