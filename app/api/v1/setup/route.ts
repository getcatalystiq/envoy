import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { sql } from "@/lib/db";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const rows = await sql`
    SELECT twin_agent_id
    FROM organizations
    WHERE id = ${auth.tenantId}::uuid
  `;

  const org = rows[0];
  const configured = Boolean(org && org.twin_agent_id);

  return new Response(
    JSON.stringify({
      twin_configured: configured,
      // Deprecated alias — kept for one release for OAuth clients still on the
      // pre-rename surface. Will be removed in v2.
      agentplane_configured: configured,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Deprecation": "agentplane_configured will be removed in v2",
      },
    }
  );
}
