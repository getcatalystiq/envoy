import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as agentplane from "@/lib/agentplane";
import { getAgentId } from "../../_helpers";

/** DELETE /api/v1/agentplane/connectors/:slug — disconnect connector */
export async function DELETE(
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
    await agentplane.deleteConnector(agentId, slug);
    return new Response(null, { status: 204 });
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}
