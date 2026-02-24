import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as agentplane from "@/lib/agentplane";
import { getAgentId } from "../../_helpers";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
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

  const { runId } = await params;

  try {
    const [run, transcript] = await Promise.all([
      agentplane.getRun(runId),
      agentplane.getRunTranscript(runId),
    ]);
    const result = run as Record<string, unknown>;
    result.transcript = transcript;
    return jsonResponse(result);
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}
