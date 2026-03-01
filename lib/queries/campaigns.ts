import { sql, getPool } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** Columns allowed in dynamic UPDATE SET clauses — prevents SQL injection via key names. */
const ALLOWED_UPDATE_COLUMNS = new Set([
  "name", "target_criteria", "skills", "scheduled_at",
  "settings", "status", "started_at", "completed_at", "stats",
  "processing_started_at",
]);

export async function getAll(
  orgId: string,
  opts: {
    status?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<Row[]> {
  const { status, limit = 100, offset = 0 } = opts;

  if (status) {
    return sql`
      SELECT * FROM campaigns
      WHERE organization_id = ${orgId} AND status = ${status}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }
  return sql`
    SELECT * FROM campaigns
    WHERE organization_id = ${orgId}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

export async function getById(
  orgId: string,
  campaignId: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT c.*,
      COALESCE(
        json_agg(
          json_build_object('id', ct.id, 'name', ct.name, 'position', cc.position)
          ORDER BY cc.position
        ) FILTER (WHERE ct.id IS NOT NULL),
        '[]'
      ) as content_items
    FROM campaigns c
    LEFT JOIN campaign_content cc ON cc.campaign_id = c.id
    LEFT JOIN content ct ON ct.id = cc.content_id
    WHERE c.id = ${campaignId}::uuid AND c.organization_id = ${orgId}
    GROUP BY c.id
  `;
  return rows[0] ?? null;
}

export async function create(
  orgId: string,
  data: {
    name: string;
    targetCriteria?: Record<string, unknown> | null;
    skills?: Record<string, unknown> | null;
    scheduledAt?: string | null;
    settings?: Record<string, unknown> | null;
  }
): Promise<Row> {
  const rows = await sql`
    INSERT INTO campaigns (
      organization_id, name, target_criteria, skills,
      scheduled_at, settings
    ) VALUES (
      ${orgId},
      ${data.name},
      ${JSON.stringify(data.targetCriteria ?? {})}::jsonb,
      ${JSON.stringify(data.skills ?? {})}::jsonb,
      ${data.scheduledAt ?? null},
      ${JSON.stringify(data.settings ?? {})}::jsonb
    )
    RETURNING *
  `;
  return rows[0];
}

export async function update(
  orgId: string,
  campaignId: string,
  fields: Record<string, unknown>
): Promise<Row | null> {
  if (!fields || Object.keys(fields).length === 0) {
    return getById(orgId, campaignId);
  }

  const jsonFields = new Set(["target_criteria", "skills", "settings", "stats"]);
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && ALLOWED_UPDATE_COLUMNS.has(key)) {
      setClauses.push(`${key} = $${idx}${jsonFields.has(key) ? "::jsonb" : ""}`);
      values.push(jsonFields.has(key) ? JSON.stringify(value) : value);
      idx++;
    }
  }

  if (setClauses.length === 0) {
    return getById(orgId, campaignId);
  }

  setClauses.push("updated_at = NOW()");
  values.push(campaignId);
  values.push(orgId);

  const query = `
    UPDATE campaigns
    SET ${setClauses.join(", ")}
    WHERE id = $${idx}::uuid AND organization_id = $${idx + 1}
    RETURNING *
  `;

  const { rows } = await getPool().query(query, values);
  return rows[0] ?? null;
}

export async function updateStatus(
  orgId: string,
  campaignId: string,
  status: string,
  extraFields: Record<string, unknown> = {}
): Promise<Row | null> {
  return update(orgId, campaignId, { status, ...extraFields });
}

export async function addContent(
  orgId: string,
  campaignId: string,
  contentId: string,
  position: number = 0
): Promise<boolean> {
  try {
    await sql`
      INSERT INTO campaign_content (campaign_id, content_id, position)
      VALUES (${campaignId}::uuid, ${contentId}::uuid, ${position})
      ON CONFLICT (campaign_id, content_id) DO UPDATE SET position = ${position}
    `;
    return true;
  } catch {
    return false;
  }
}

export async function removeContent(
  campaignId: string,
  contentId: string
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM campaign_content
    WHERE campaign_id = ${campaignId}::uuid AND content_id = ${contentId}::uuid
  `;
  return rows.length === 1;
}

export async function deleteCampaign(
  orgId: string,
  campaignId: string
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM campaigns
    WHERE id = ${campaignId}::uuid AND organization_id = ${orgId}
  `;
  return rows.length === 1;
}

export async function getScheduled(): Promise<Row[]> {
  return sql`
    SELECT * FROM campaigns
    WHERE status = 'scheduled'
      AND scheduled_at <= NOW()
    ORDER BY scheduled_at ASC
  `;
}

export async function updateStats(
  orgId: string,
  campaignId: string,
  stats: Record<string, unknown>
): Promise<void> {
  await sql`
    UPDATE campaigns
    SET stats = stats || ${JSON.stringify(stats)}::jsonb, updated_at = NOW()
    WHERE id = ${campaignId}::uuid AND organization_id = ${orgId}
  `;
}
