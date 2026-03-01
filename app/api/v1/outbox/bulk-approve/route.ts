import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import { wrapEmailBody } from "@/lib/email";
import { withTransaction } from "@/lib/db";

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const body = await request.json();
  const outboxIds: string[] = body.outbox_ids ?? body;

  if (!Array.isArray(outboxIds) || outboxIds.length === 0) {
    return jsonResponse({ error: "outbox_ids array is required" }, 400);
  }

  const result = await withTransaction(async (client) => {
    let approved = 0;
    const errors: Array<{ id: string; error: string }> = [];

    for (const outboxId of outboxIds) {
      try {
        const { rows } = await client.query(
          `UPDATE outbox
           SET status = 'approved', reviewed_by = $1::uuid, reviewed_at = NOW()
           WHERE id = $2::uuid AND organization_id = $3 AND status = 'pending'
           RETURNING *`,
          [auth.userId, outboxId, auth.tenantId]
        );
        const item = rows[0];
        if (item) {
          approved++;
          if (item.channel === "email") {
            const emailBody = item.body ? wrapEmailBody(item.body) : "";
            await client.query(
              `INSERT INTO email_sends
                (organization_id, target_id, email, subject, body, status, outbox_id)
               SELECT $1, $2::uuid, t.email, $3, $4, 'queued', $5::uuid
               FROM targets t
               WHERE t.id = $2::uuid`,
              [auth.tenantId, item.target_id, item.subject || "", emailBody, outboxId]
            );
          }
        } else {
          errors.push({ id: outboxId, error: "Item not pending" });
        }
      } catch (e: unknown) {
        errors.push({ id: outboxId, error: String(e) });
      }
    }

    return { approved, errors };
  });

  return jsonResponse(result);
}
