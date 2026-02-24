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

  return jsonResponse(sequence);
}

export async function PATCH(
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

  const body = await request.json();

  // Handle is_default: ensure only one default per target_type
  if (body.is_default === true) {
    const targetTypeId = body.target_type_id ?? existing.target_type_id;
    if (!targetTypeId) {
      return jsonResponse(
        { detail: "Cannot set as default - sequence has no target type" },
        400
      );
    }
    if (existing.status !== "active") {
      return jsonResponse(
        { detail: "Only active sequences can be set as default" },
        400
      );
    }
    await sequences.unsetDefaultForTargetType(auth.tenantId, targetTypeId);
  }

  const updated = await sequences.update(auth.tenantId, id, body);
  return jsonResponse({ ...updated, steps: existing.steps ?? [] });
}

export async function DELETE(
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

  if (existing.status === "active") {
    return jsonResponse(
      { detail: "Cannot delete active sequence. Archive it first." },
      400
    );
  }

  await sequences.remove(auth.tenantId, id);
  return new Response(null, { status: 204 });
}
