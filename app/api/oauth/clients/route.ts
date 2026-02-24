import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { sql } from "@/lib/db";
import { jsonResponse } from "@/lib/utils";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const rows = await sql`
    SELECT client_id, client_name, client_uri, redirect_uris,
           grant_types, response_types, token_endpoint_auth_method,
           scope, is_active, created_at
    FROM oauth_clients
    WHERE organization_id = ${auth.tenantId}::uuid
    ORDER BY created_at DESC
  `;

  return jsonResponse({ clients: rows });
}
