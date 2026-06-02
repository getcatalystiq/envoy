import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { sql } from "@/lib/db";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const rows = await sql`
    SELECT agent_id
    FROM organizations
    WHERE id = ${auth.tenantId}::uuid
  `;

  const org = rows[0];
  const configured = Boolean(org && org.agent_id);

  return new Response(
    JSON.stringify({
      agent_configured: configured,
      // Deprecated alias — kept for one release for clients still on the
      // pre-rename surface. Will be removed next release.
      twin_configured: configured,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Deprecation": "twin_configured will be removed next release",
      },
    }
  );
}
