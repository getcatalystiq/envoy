import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import { sql } from "@/lib/db";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const rows = await sql`
    SELECT id, name, description, created_at
    FROM segments
    WHERE organization_id = ${auth.tenantId}
    ORDER BY name ASC
  `;

  return jsonResponse(rows);
}
