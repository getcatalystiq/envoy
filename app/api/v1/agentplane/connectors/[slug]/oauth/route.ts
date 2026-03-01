import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as agentplane from "@/lib/agentplane";
import { getAgentId } from "../../../_helpers";

/** POST /api/v1/agentplane/connectors/:slug/oauth — initiate OAuth flow */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const agentId = await getAgentId(auth.tenantId);
  if (!agentId) {
    return jsonResponse(
      { error: "Organization not configured for AgentPlane" },
      503,
    );
  }

  const { slug } = await params;

  try {
    const result = await agentplane.initiateConnectorOauth(agentId, slug);
    return jsonResponse(result);
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}
