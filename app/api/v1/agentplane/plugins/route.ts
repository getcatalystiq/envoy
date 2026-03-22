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
    const agent = (await agentplane.getAgent(agentId)) as Record<
      string,
      unknown
    >;
    const plugins = (agent.plugins ?? []) as Record<string, unknown>[];
    return jsonResponse({ plugins });
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}

export async function POST(request: Request) {
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
    const agent = (await agentplane.getAgent(agentId)) as Record<
      string,
      unknown
    >;
    const plugins = (agent.plugins ?? []) as Record<string, unknown>[];
    plugins.push(body);
    await agentplane.updateAgent(agentId, { plugins });
    return jsonResponse(body, 201);
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}
