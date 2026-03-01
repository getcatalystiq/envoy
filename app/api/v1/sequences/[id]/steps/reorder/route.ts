import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as sequences from "@/lib/queries/sequences";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const sequence = await sequences.getById(auth.tenantId, id);
  if (!sequence) {
    return jsonResponse({ detail: "Sequence not found" }, 404);
  }

  if (sequence.status === "active") {
    return jsonResponse({ detail: "Cannot modify active sequence" }, 400);
  }

  const body = await request.json();
  const { step_ids } = body;

  if (!Array.isArray(step_ids) || step_ids.length === 0) {
    return jsonResponse({ error: "step_ids array is required" }, 400);
  }

  // Update each step's position based on its index in the array
  for (let i = 0; i < step_ids.length; i++) {
    await sequences.updateStep(auth.tenantId, step_ids[i], { position: i + 1 });
  }

  const steps = await sequences.getSteps(auth.tenantId, id);
  return jsonResponse(steps);
}
