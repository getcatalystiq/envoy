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
  const existing = await sequences.getById(auth.tenantId, id);
  if (!existing) {
    return jsonResponse({ detail: "Sequence not found" }, 404);
  }

  if (existing.status !== "draft" && existing.status !== "paused") {
    return jsonResponse(
      { detail: `Cannot activate sequence in ${existing.status} status` },
      400
    );
  }

  const steps = await sequences.getSteps(auth.tenantId, id);
  if (!steps.length) {
    return jsonResponse(
      { detail: "Cannot activate sequence without steps" },
      400
    );
  }

  const sequence = await sequences.update(auth.tenantId, id, { status: "active" });
  await sequences.resumeAllEnrollments(auth.tenantId, id);

  return jsonResponse({ ...sequence, steps: existing.steps ?? [] });
}
