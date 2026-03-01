import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import { wrapEmailBody } from "@/lib/email";
import { sql } from "@/lib/db";
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
    return jsonResponse({ detail: "Can only approve pending items" }, 400);
  }

  const item = await outbox.approve(auth.tenantId, id, auth.userId);
  if (!item) {
    return jsonResponse({ detail: "Failed to approve item" }, 400);
  }

  // Create email_sends record for the email scheduler to pick up
  if (item.channel === "email") {
    const body = item.body ? wrapEmailBody(item.body) : "";
    await sql`
      INSERT INTO email_sends
        (organization_id, target_id, email, subject, body, status, outbox_id)
      SELECT ${auth.tenantId}, ${item.target_id}::uuid, t.email,
             ${item.subject || ""}, ${body}, 'queued', ${id}::uuid
      FROM targets t
      WHERE t.id = ${item.target_id}::uuid
    `;
  }

  return jsonResponse(item);
}
