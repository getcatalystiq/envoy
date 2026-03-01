import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as segments from "@/lib/queries/segments";
import * as targetTypes from "@/lib/queries/target-types";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const segment = await segments.getById(auth.tenantId, id);
  if (!segment) {
    return jsonResponse({ error: "Segment not found" }, 404);
  }

  return jsonResponse(segment);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const current = await segments.getById(auth.tenantId, id);
  if (!current) {
    return jsonResponse({ error: "Segment not found" }, 404);
  }

  const body = await request.json();
  const { name, description, target_type_id, pain_points, objections } = body;

  const effectiveTargetTypeId = target_type_id ?? current.target_type_id;

  if (target_type_id) {
    const targetType = await targetTypes.getById(auth.tenantId, target_type_id);
    if (!targetType) {
      return jsonResponse({ error: "Target type not found" }, 400);
    }
  }

  if (name || target_type_id) {
    const nameToCheck = name ?? current.name;
    const existing = await segments.getByName(auth.tenantId, effectiveTargetTypeId, nameToCheck);
    if (existing && existing.id !== id) {
      return jsonResponse(
        { error: `Segment with name '${nameToCheck}' already exists for this target type` },
        400
      );
    }
  }

  const segment = await segments.update(auth.tenantId, id, {
    name,
    description,
    targetTypeId: target_type_id,
    painPoints: pain_points,
    objections,
  });

  if (!segment) {
    return jsonResponse({ error: "Segment not found" }, 404);
  }

  return jsonResponse(segment);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const segment = await segments.getById(auth.tenantId, id);
  if (!segment) {
    return jsonResponse({ error: "Segment not found" }, 404);
  }

  const deleted = await segments.deleteSegment(auth.tenantId, id);
  if (!deleted) {
    return jsonResponse({ error: "Segment not found" }, 404);
  }

  return new Response(null, { status: 204 });
}
