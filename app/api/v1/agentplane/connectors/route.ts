import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as agentplane from "@/lib/agentplane";
import { getAgentId } from "../_helpers";

function normalizeConnector(raw: Record<string, unknown>): Record<string, unknown> {
  const connected = raw.connected === true;
  return {
    slug: raw.slug ?? "",
    name: raw.name ?? "",
    logo: raw.logo ?? "",
    authScheme: raw.auth_scheme ?? "OTHER",
    authConfigId: null,
    connectedAccountId: null,
    connectionStatus: connected ? "ACTIVE" : null,
  };
}

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
    const result = (await agentplane.listConnectors(agentId)) as Record<
      string,
      unknown
    >;
    const data = (result.data ?? []) as Record<string, unknown>[];
    const connectors = data.map(normalizeConnector);
    return jsonResponse({ connectors });
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}
