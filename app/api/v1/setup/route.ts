import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { sql } from "@/lib/db";
import { jsonResponse } from "@/lib/utils";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const rows = await sql`
    SELECT agentplane_tenant_id, agentplane_agent_id
    FROM organizations
    WHERE id = ${auth.tenantId}::uuid
  `;

  const org = rows[0];

  return jsonResponse({
    agentplane_configured: Boolean(
      org && org.agentplane_tenant_id && org.agentplane_agent_id
    ),
  });
}
