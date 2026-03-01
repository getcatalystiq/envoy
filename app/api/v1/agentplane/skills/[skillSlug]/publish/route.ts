import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as agentplane from "@/lib/agentplane";
import { getAgentId } from "../../../_helpers";
import { findRawSkill } from "../../_skill-helpers";

/** POST /api/v1/agentplane/skills/:skillSlug/publish — publish skill (no-op confirmation) */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ skillSlug: string }> },
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

  const { skillSlug } = await params;

  try {
    const agent = (await agentplane.getAgent(agentId)) as Record<
      string,
      unknown
    >;
    const skills = (agent.skills ?? []) as Record<string, unknown>[];
    const found = findRawSkill(skills, skillSlug);
    if (!found) return jsonResponse({ error: "Skill not found" }, 404);

    return jsonResponse({ status: "published" });
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}
