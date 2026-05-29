import { requireScope, isErrorResponse } from "@/lib/admin-auth";
import { sql } from "@/lib/db";
import { jsonResponse } from "@/lib/utils";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // OAuth client deletion is administrative — require admin scope, not merely write.
  const auth = await requireScope(request, "admin");
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;

  const rows = await sql`
    DELETE FROM oauth_clients
    WHERE client_id = ${id}
      AND organization_id = ${auth.tenantId}::uuid
    RETURNING client_id
  `;

  if (rows.length === 0) {
    return jsonResponse({ error: "Client not found" }, 404);
  }

  return jsonResponse({ deleted: true });
}
