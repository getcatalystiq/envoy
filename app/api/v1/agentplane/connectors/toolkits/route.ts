import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import { getAgentId } from "../../_helpers";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const agentId = await getAgentId(auth.tenantId);
  if (!agentId) {
    return jsonResponse([], 200);
  }

  try {
    const { AgentPlane } = await import("@getcatalystiq/agent-plane");
    const { getEnv } = await import("@/lib/env");
    const env = getEnv();
    const client = new AgentPlane({
      baseUrl: env.AGENTPLANE_API_URL,
      apiKey: env.AGENTPLANE_API_KEY,
    });
    const toolkits = await client.agents.connectors.availableToolkits();
    return jsonResponse(toolkits);
  } catch {
    return jsonResponse([]);
  }
}
