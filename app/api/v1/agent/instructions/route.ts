import { jsonResponse } from "@/lib/utils";
import { sql } from "@/lib/db";
import { getAgentInstructions, updateAgentInstructions } from "@/lib/agent-session";
import { withAgent } from "../_helpers";

export async function GET(request: Request) {
  return withAgent(request, async ({ agentId }) => {
    const system = await getAgentInstructions(agentId);
    return jsonResponse({ instructions: system });
  });
}

export async function PUT(request: Request) {
  return withAgent(request, async ({ agentId, auth }) => {
    const body = await request.json().catch(() => ({}));
    const content = (body as { content?: unknown }).content;
    if (typeof content !== "string" || content.trim().length === 0) {
      return jsonResponse(
        { error: "content is required and must be a non-empty string" },
        400,
      );
    }

    await updateAgentInstructions(agentId, content);

    // Audit trail: record who changed the agent's instructions and what they
    // set. agents.update overwrites silently — without this we have no app-side
    // record of the actor or prior content. Best-effort: a failure here must
    // not roll back the (already-applied) update.
    try {
      await sql`
        INSERT INTO twin_instruction_updates (organization_id, user_id, content)
        VALUES (${auth.tenantId}::uuid, ${auth.userId}::uuid, ${content})
      `;
    } catch (err) {
      console.error(
        `Failed to record instruction-update audit row for org ${auth.tenantId}:`,
        err,
      );
    }

    return jsonResponse({ success: true });
  });
}
