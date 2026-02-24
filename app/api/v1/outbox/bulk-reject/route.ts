import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import { withTransaction } from "@/lib/db";

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const body = await request.json();
  const { outbox_ids, reason } = body;

  if (!Array.isArray(outbox_ids) || outbox_ids.length === 0) {
    return jsonResponse({ error: "outbox_ids array is required" }, 400);
  }

  const result = await withTransaction(async (client) => {
    let rejected = 0;
    const errors: Array<{ id: string; error: string }> = [];

    for (const outboxId of outbox_ids) {
      try {
        const { rows } = await client.query(
          `UPDATE outbox
           SET status = 'rejected', rejection_reason = $1,
               reviewed_by = $2::uuid, reviewed_at = NOW()
           WHERE id = $3::uuid AND organization_id = $4 AND status = 'pending'
           RETURNING *`,
          [reason, auth.userId, outboxId, auth.tenantId]
        );
        if (rows[0]) {
          rejected++;
        } else {
          errors.push({ id: outboxId, error: "Item not pending" });
        }
      } catch (e: unknown) {
        errors.push({ id: outboxId, error: String(e) });
      }
    }

    return { rejected, errors };
  });

  return jsonResponse(result);
}
