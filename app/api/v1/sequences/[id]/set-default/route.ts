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

  if (!existing.target_type_id) {
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

  await sequences.unsetDefaultForTargetType(auth.tenantId, existing.target_type_id);
  const sequence = await sequences.update(auth.tenantId, id, { is_default: true });

  return jsonResponse({ ...sequence, steps: existing.steps ?? [] });
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

  if (!existing.is_default) {
    return jsonResponse({ detail: "Sequence is not a default" }, 400);
  }

  const sequence = await sequences.update(auth.tenantId, id, { is_default: false });
  return jsonResponse({ ...sequence, steps: existing.steps ?? [] });
}
