import { jsonResponse } from "@/lib/utils";
import { sql } from "@/lib/db";
import * as twin from "@/lib/twin";
import { twinUpdateInstructionsRequestSchema } from "@/lib/schemas";
import { withTwinAgent } from "../_helpers";

export async function GET(request: Request) {
  return withTwinAgent(request, async ({ agentId, apiKey }) => {
    const instructions = await twin.getInstructions(agentId, { apiKey });
    return jsonResponse({ instructions });
  });
}

export async function PUT(request: Request) {
  return withTwinAgent(request, async ({ agentId, apiKey, auth }) => {
    const body = await request.json().catch(() => ({}));
    const parsed = twinUpdateInstructionsRequestSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(
        { error: "Invalid request body", detail: parsed.error.issues },
        400,
      );
    }
    await twin.updateInstructions(agentId, parsed.data.content, { apiKey });

    // Audit trail: record who changed the agent's instructions and what they
    // set. Twin's PUT silently overwrites — without this we have no app-side
    // record of the actor or prior content. Best-effort: a failure here must
    // not roll back the (already-applied) Twin change.
    try {
      await sql`
        INSERT INTO twin_instruction_updates (organization_id, user_id, content)
        VALUES (${auth.tenantId}::uuid, ${auth.userId}::uuid, ${parsed.data.content})
      `;
    } catch (err) {
      console.error(
        `Failed to record twin_instruction_updates audit row for org ${auth.tenantId}:`,
        err,
      );
    }

    return jsonResponse({ success: true });
  });
}
