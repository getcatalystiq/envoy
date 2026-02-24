import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as targetTypes from "@/lib/queries/target-types";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const targetType = await targetTypes.getById(auth.tenantId, id);
  if (!targetType) {
    return jsonResponse({ error: "Target type not found" }, 404);
  }

  return jsonResponse(targetType);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const body = await request.json();
  const { name, description } = body;

  if (name) {
    const existing = await targetTypes.getByName(auth.tenantId, name);
    if (existing && existing.id !== id) {
      return jsonResponse(
        { error: `Target type with name '${name}' already exists` },
        400
      );
    }
  }

  const targetType = await targetTypes.update(auth.tenantId, id, { name, description });
  if (!targetType) {
    return jsonResponse({ error: "Target type not found" }, 404);
  }

  return jsonResponse(targetType);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const targetType = await targetTypes.getById(auth.tenantId, id);
  if (!targetType) {
    return jsonResponse({ error: "Target type not found" }, 404);
  }

  const usage = await targetTypes.getUsageCount(id);
  if (usage.sequences > 0) {
    return jsonResponse(
      {
        error: `Cannot delete: ${usage.sequences} sequence(s) use this target type. Delete or reassign sequences first.`,
      },
      400
    );
  }

  const deleted = await targetTypes.deleteTargetType(auth.tenantId, id);
  if (!deleted) {
    return jsonResponse({ error: "Target type not found" }, 404);
  }

  return new Response(null, { status: 204 });
}
