import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as agentplane from "@/lib/agentplane";
import { getAgentId } from "../../../_helpers";

/** POST /api/v1/agentplane/connectors/:slug/api-key — save API key */
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
  const body = await request.json();
  const apiKey = body.api_key as string;

  if (!apiKey) {
    return jsonResponse({ error: "api_key is required" }, 400);
  }

  try {
    const result = await agentplane.saveConnectorApiKey(agentId, slug, apiKey);
    return jsonResponse(result);
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}
