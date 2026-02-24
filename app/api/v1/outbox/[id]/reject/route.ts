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
    return jsonResponse({ detail: "Can only reject pending items" }, 400);
  }

  const body = await request.json();
  const item = await outbox.reject(auth.tenantId, id, body.reason, auth.userId);
  if (!item) {
    return jsonResponse({ detail: "Failed to reject item" }, 400);
  }

  return jsonResponse(item);
}
