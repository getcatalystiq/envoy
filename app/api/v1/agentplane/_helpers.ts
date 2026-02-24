import { sql } from "@/lib/db";

/** Resolve the AgentPlane agent ID for an organization. */
export async function getAgentId(orgId: string): Promise<string | null> {
  const rows = await sql`
    SELECT agentplane_agent_id FROM organizations WHERE id = ${orgId}
  `;
  if (rows.length === 0 || !rows[0].agentplane_agent_id) return null;
  return rows[0].agentplane_agent_id;
}
