import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as targets from "@/lib/queries/targets";
import { evaluateAndGraduate, GraduationError } from "@/lib/graduation";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const target = await targets.getById(auth.tenantId, id);
  if (!target) {
    return jsonResponse({ error: "Target not found" }, 404);
  }

  return jsonResponse(target);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const existing = await targets.getById(auth.tenantId, id);
  if (!existing) {
    return jsonResponse({ error: "Target not found" }, 404);
  }

  const body = await request.json();

  // Check if graduation-relevant fields changed
  const graduationFields = new Set(["lifecycle_stage", "custom_fields", "metadata", "status"]);
  const shouldEvaluateGraduation =
    Object.keys(body).some((f) => graduationFields.has(f)) && existing.target_type_id;

  let target = await targets.update(auth.tenantId, id, body);

  if (shouldEvaluateGraduation) {
    try {
      const result = await evaluateAndGraduate(auth.tenantId, id);
      if (result) {
        target = await targets.getById(auth.tenantId, id);
      }
    } catch (e) {
      if (!(e instanceof GraduationError)) throw e;
      // Log but don't fail the update
    }
  }

  return jsonResponse(target);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const target = await targets.getById(auth.tenantId, id);
  if (!target) {
    return jsonResponse({ error: "Target not found" }, 404);
  }

  await targets.deleteTarget(auth.tenantId, id);
  return new Response(null, { status: 204 });
}
