import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as graduation from "@/lib/queries/graduation";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const rule = await graduation.getRuleById(auth.tenantId, id);
  if (!rule) {
    return jsonResponse({ error: "Graduation rule not found" }, 404);
  }

  return jsonResponse(rule);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const existing = await graduation.getRuleById(auth.tenantId, id);
  if (!existing) {
    return jsonResponse({ error: "Graduation rule not found" }, 404);
  }

  const body = await request.json();

  // Check for cycles if enabling
  const willBeEnabled = body.enabled ?? existing.enabled;
  if (willBeEnabled) {
    const hasCycle = await graduation.checkForCycle(
      auth.tenantId,
      existing.source_target_type_id,
      existing.destination_target_type_id,
      id
    );
    if (hasCycle) {
      return jsonResponse(
        { error: "Enabling this rule would create a circular graduation path" },
        400
      );
    }
  }

  const rule = await graduation.updateRule(auth.tenantId, id, body);
  return jsonResponse(rule);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const deleted = await graduation.deleteRule(auth.tenantId, id);
  if (!deleted) {
    return jsonResponse({ error: "Graduation rule not found" }, 404);
  }

  return new Response(null, { status: 204 });
}
