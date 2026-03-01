import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as sequences from "@/lib/queries/sequences";

export async function GET(
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

  const steps = await sequences.getSteps(auth.tenantId, id);
  return jsonResponse(steps);
}

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
  const { position, default_delay_hours = 24 } = body;

  if (position === undefined || position === null) {
    return jsonResponse({ error: "position is required" }, 400);
  }

  const step = await sequences.createStep(
    auth.tenantId,
    id,
    position,
    default_delay_hours
  );

  return jsonResponse(step, 201);
}
