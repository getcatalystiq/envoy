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

  if (existing.status !== "pending") {
    return jsonResponse({ detail: "Can only snooze pending items" }, 400);
  }

  const body = await request.json();
  if (!body.snooze_until) {
    return jsonResponse({ error: "snooze_until is required" }, 400);
  }

  const item = await outbox.snooze(
    auth.tenantId,
    id,
    new Date(body.snooze_until).toISOString(),
    auth.userId
  );
  if (!item) {
    return jsonResponse({ detail: "Failed to snooze item" }, 400);
  }

  return jsonResponse(item);
}
