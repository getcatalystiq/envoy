import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as outbox from "@/lib/queries/outbox";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const existing = await outbox.getById(auth.tenantId, id);
  if (!existing) {
    return jsonResponse({ detail: "Outbox item not found" }, 404);
  }

  const body = await request.json();
  const { field, old_value, new_value } = body;

  if (!field || old_value === undefined || new_value === undefined) {
    return jsonResponse(
      { error: "field, old_value, and new_value are required" },
      400
    );
  }

  const item = await outbox.addEdit(
    auth.tenantId,
    id,
    auth.userId,
    field,
    old_value,
    new_value
  );

  return jsonResponse(item);
}
