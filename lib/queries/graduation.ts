import { sql } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export async function getRules(
  orgId: string,
  opts: { sourceTargetTypeId?: string; enabled?: boolean } = {}
): Promise<Row[]> {
  const { sourceTargetTypeId = null, enabled = null } = opts;
  const rows = await sql`
    SELECT gr.*,
           st.name as source_type_name,
           dt.name as destination_type_name
    FROM graduation_rules gr
    JOIN target_types st ON st.id = gr.source_target_type_id
    JOIN target_types dt ON dt.id = gr.destination_target_type_id
    WHERE gr.organization_id = ${orgId}
      AND (${sourceTargetTypeId}::uuid IS NULL OR gr.source_target_type_id = ${sourceTargetTypeId}::uuid)
      AND (${enabled}::bool IS NULL OR gr.enabled = ${enabled})
    ORDER BY gr.created_at
  `;
  return rows;
}

export async function getRuleById(
  orgId: string,
  ruleId: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT gr.*,
           st.name as source_type_name,
           dt.name as destination_type_name
    FROM graduation_rules gr
    JOIN target_types st ON st.id = gr.source_target_type_id
    JOIN target_types dt ON dt.id = gr.destination_target_type_id
    WHERE gr.id = ${ruleId}::uuid AND gr.organization_id = ${orgId}
  `;
  return rows[0] ?? null;
}

export async function createRule(
  orgId: string,
  sourceTargetTypeId: string,
  destinationTargetTypeId: string,
  name: string,
  conditions: Record<string, unknown>[],
  opts: { description?: string; enabled?: boolean } = {}
): Promise<Row> {
  const { description = null, enabled = true } = opts;
  const rows = await sql`
    INSERT INTO graduation_rules
      (organization_id, source_target_type_id, destination_target_type_id,
       name, description, conditions, enabled)
    VALUES (
      ${orgId}, ${sourceTargetTypeId}::uuid, ${destinationTargetTypeId}::uuid,
      ${name}, ${description}, ${JSON.stringify(conditions)}::jsonb, ${enabled}
    )
    RETURNING *
  `;
  return rows[0];
}

export async function updateRule(
  orgId: string,
  ruleId: string,
  updates: Record<string, unknown>
): Promise<Row | null> {
  if (!updates || Object.keys(updates).length === 0) {
    return getRuleById(orgId, ruleId);
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (key === "conditions") {
      values.push(JSON.stringify(value));
      setClauses.push(`${key} = $${values.length + 2}::jsonb`);
    } else {
      values.push(value);
      setClauses.push(`${key} = $${values.length + 2}`);
    }
  }

  const query = `
    UPDATE graduation_rules
    SET ${setClauses.join(", ")}
    WHERE id = $1::uuid AND organization_id = $2
    RETURNING *
  `;
  const rows = await sql.query(query, [ruleId, orgId, ...values]);
  return rows[0] ?? null;
}

export async function deleteRule(
  orgId: string,
  ruleId: string
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM graduation_rules
    WHERE id = ${ruleId}::uuid AND organization_id = ${orgId}
    RETURNING id
  `;
  return rows.length > 0;
}

export async function getRulesForTargetType(
  orgId: string,
  targetTypeId: string
): Promise<Row[]> {
  const rows = await sql`
    SELECT * FROM graduation_rules
    WHERE organization_id = ${orgId}
      AND source_target_type_id = ${targetTypeId}::uuid
      AND enabled = TRUE
    ORDER BY created_at
  `;
  return rows;
}

export async function recordGraduation(
  orgId: string,
  targetId: string,
  sourceTargetTypeId: string,
  destinationTargetTypeId: string,
  opts: {
    ruleId?: string;
    manual?: boolean;
    triggeredByUserId?: string;
  } = {}
): Promise<Row> {
  const { ruleId = null, manual = false, triggeredByUserId = null } = opts;
  const rows = await sql`
    INSERT INTO graduation_events
      (organization_id, target_id, rule_id, source_target_type_id,
       destination_target_type_id, manual, triggered_by_user_id)
    VALUES (
      ${orgId}, ${targetId}::uuid, ${ruleId}::uuid, ${sourceTargetTypeId}::uuid,
      ${destinationTargetTypeId}::uuid, ${manual}, ${triggeredByUserId}::uuid
    )
    RETURNING *
  `;
  return rows[0];
}

export async function checkForCycle(
  orgId: string,
  sourceTypeId: string,
  destinationTypeId: string,
  excludeRuleId: string | null = null
): Promise<boolean> {
  const visited = new Set<string>();
  const stack = [destinationTypeId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === sourceTypeId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const rows = await sql`
      SELECT destination_target_type_id
      FROM graduation_rules
      WHERE organization_id = ${orgId}
        AND source_target_type_id = ${current}::uuid
        AND enabled = TRUE
        AND (${excludeRuleId}::uuid IS NULL OR id != ${excludeRuleId}::uuid)
    `;

    for (const row of rows) {
      stack.push(String(row.destination_target_type_id));
    }
  }

  return false;
}

export async function getEvents(
  orgId: string,
  limit: number = 50,
  offset: number = 0
): Promise<Row[]> {
  const rows = await sql`
    SELECT
      ge.id,
      ge.target_id,
      t.email as target_email,
      ge.rule_id,
      gr.name as rule_name,
      ge.source_target_type_id,
      st.name as source_type_name,
      ge.destination_target_type_id,
      dt.name as destination_type_name,
      ge.manual,
      ge.triggered_by_user_id,
      u.email as triggered_by_email,
      ge.created_at
    FROM graduation_events ge
    LEFT JOIN targets t ON t.id = ge.target_id
    LEFT JOIN graduation_rules gr ON gr.id = ge.rule_id
    JOIN target_types st ON st.id = ge.source_target_type_id
    JOIN target_types dt ON dt.id = ge.destination_target_type_id
    LEFT JOIN users u ON u.id = ge.triggered_by_user_id
    WHERE ge.organization_id = ${orgId}
    ORDER BY ge.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows;
}
