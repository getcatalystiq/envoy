import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as sequences from "@/lib/queries/sequences";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; stepId: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id, stepId } = await params;
  const sequence = await sequences.getById(auth.tenantId, id);
  if (!sequence) {
    return jsonResponse({ detail: "Sequence not found" }, 404);
  }

  const step = await sequences.getStepById(auth.tenantId, stepId);
  if (!step || step.sequence_id !== id) {
    return jsonResponse({ detail: "Step not found" }, 404);
  }

  return jsonResponse(step);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; stepId: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id, stepId } = await params;
  const sequence = await sequences.getById(auth.tenantId, id);
  if (!sequence) {
    return jsonResponse({ detail: "Sequence not found" }, 404);
  }

  if (sequence.status === "active") {
    return jsonResponse({ detail: "Cannot modify active sequence" }, 400);
  }

  const step = await sequences.getStepById(auth.tenantId, stepId);
  if (!step || step.sequence_id !== id) {
    return jsonResponse({ detail: "Step not found" }, 404);
  }

  const body = await request.json();
  const updated = await sequences.updateStep(auth.tenantId, stepId, body);
  return jsonResponse(updated);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; stepId: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id, stepId } = await params;
  const sequence = await sequences.getById(auth.tenantId, id);
  if (!sequence) {
    return jsonResponse({ detail: "Sequence not found" }, 404);
  }

  if (sequence.status === "active") {
    return jsonResponse({ detail: "Cannot modify active sequence" }, 400);
  }

  const step = await sequences.getStepById(auth.tenantId, stepId);
  if (!step || step.sequence_id !== id) {
    return jsonResponse({ detail: "Step not found" }, 404);
  }

  await sequences.deleteStep(auth.tenantId, stepId);
  return new Response(null, { status: 204 });
}
