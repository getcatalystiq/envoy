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

  if (existing.status !== "failed") {
    return jsonResponse({ detail: "Can only retry failed items" }, 400);
  }

  const item = await outbox.retry(auth.tenantId, id);
  if (!item) {
    return jsonResponse({ detail: "Failed to retry item" }, 400);
  }

  // Re-create email_sends record for the email scheduler
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
