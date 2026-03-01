import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as outbox from "@/lib/queries/outbox";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const item = await outbox.getById(auth.tenantId, id);
  if (!item) {
    return jsonResponse({ detail: "Outbox item not found" }, 404);
  }

  return jsonResponse(item);
}

export async function PATCH(
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

  if (existing.status !== "pending" && existing.status !== "snoozed") {
    return jsonResponse(
      { detail: "Can only edit pending or snoozed items" },
      400
    );
  }

  const body = await request.json();

  // Track edits for audit trail
  if (body.subject !== undefined && body.subject !== existing.subject) {
    await outbox.addEdit(
      auth.tenantId,
      id,
      auth.userId,
      "subject",
      existing.subject || "",
      body.subject || ""
    );
  }
  if (body.body !== undefined && body.body !== existing.body) {
    await outbox.addEdit(
      auth.tenantId,
      id,
      auth.userId,
      "body",
      existing.body || "",
      body.body || ""
    );
  }

  if (body.scheduled_for) {
    body.scheduled_for = new Date(body.scheduled_for).toISOString();
  }

  const item = await outbox.update(auth.tenantId, id, body);
  return jsonResponse(item);
}

export async function DELETE(
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

  if (existing.status === "sent" || existing.status === "approved") {
    return jsonResponse(
      { detail: "Cannot delete sent or approved items" },
      400
    );
  }

  const deleted = await outbox.remove(auth.tenantId, id);
  if (!deleted) {
    return jsonResponse({ detail: "Outbox item not found" }, 404);
  }

  return new Response(null, { status: 204 });
}
