import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import { sql } from "@/lib/db";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sendId: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { sendId } = await params;
  const rows = await sql`
    SELECT id, email, status, ses_message_id, sent_at
    FROM email_sends
    WHERE id = ${sendId}::uuid AND organization_id = ${auth.tenantId}
  `;

  if (!rows.length) {
    return jsonResponse({ detail: "Send not found" }, 404);
  }

  return jsonResponse(rows[0]);
}
