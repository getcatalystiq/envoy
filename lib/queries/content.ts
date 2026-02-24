import { sql, getPool } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export async function getAll(
  orgId: string,
  opts: {
    contentType?: string;
    channel?: string;
    targetTypeId?: string;
    segmentId?: string;
    lifecycleStage?: number;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<Row[]> {
  const {
    contentType,
    channel,
    targetTypeId,
    segmentId,
    lifecycleStage,
    status,
    limit = 100,
    offset = 0,
  } = opts;

  const rows = await sql`
    SELECT * FROM content
    WHERE organization_id = ${orgId}
      AND (${contentType ?? null}::text IS NULL OR content_type = ${contentType ?? null})
      AND (${channel ?? null}::text IS NULL OR channel = ${channel ?? null})
      AND (${targetTypeId ?? null}::uuid IS NULL OR target_type_id = ${targetTypeId ?? null}::uuid)
      AND (${segmentId ?? null}::uuid IS NULL OR segment_id = ${segmentId ?? null}::uuid)
      AND (${lifecycleStage ?? null}::int IS NULL OR lifecycle_stage = ${lifecycleStage ?? null})
      AND (${status ?? null}::text IS NULL OR status = ${status ?? null})
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows;
}

export async function getById(
  orgId: string,
  contentId: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT * FROM content
    WHERE id = ${contentId}::uuid AND organization_id = ${orgId}
  `;
  return rows[0] ?? null;
}

export async function create(
  orgId: string,
  data: {
    name: string;
    contentType: string;
    body: string;
    channel?: string;
    subject?: string | null;
    targetTypeId?: string | null;
    segmentId?: string | null;
    lifecycleStage?: number | null;
    status?: string;
  }
): Promise<Row> {
  const rows = await sql`
    INSERT INTO content (
      organization_id, name, content_type, channel, subject, body,
      target_type_id, segment_id, lifecycle_stage, status
    ) VALUES (
      ${orgId},
      ${data.name},
      ${data.contentType},
      ${data.channel ?? "email"},
      ${data.subject ?? null},
      ${data.body},
      ${data.targetTypeId ?? null}::uuid,
      ${data.segmentId ?? null}::uuid,
      ${data.lifecycleStage ?? null},
      ${data.status ?? "draft"}
    )
    RETURNING *
  `;
  return rows[0];
}

export async function update(
  orgId: string,
  contentId: string,
  fields: Record<string, unknown>
): Promise<Row | null> {
  if (!fields || Object.keys(fields).length === 0) {
    return getById(orgId, contentId);
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      setClauses.push(`${key} = $${idx}`);
      values.push(value);
      idx++;
    }
  }

  if (setClauses.length === 0) {
    return getById(orgId, contentId);
  }

  setClauses.push("updated_at = NOW()");
  values.push(contentId);
  values.push(orgId);

  const query = `
    UPDATE content
    SET ${setClauses.join(", ")}
    WHERE id = $${idx}::uuid AND organization_id = $${idx + 1}
    RETURNING *
  `;

  const { rows } = await getPool().query(query, values);
  return rows[0] ?? null;
}

export async function deleteContent(
  orgId: string,
  contentId: string
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM content
    WHERE id = ${contentId}::uuid AND organization_id = ${orgId}
  `;
  return rows.length === 1;
}

export async function findBestMatch(
  orgId: string,
  opts: {
    targetTypeId?: string | null;
    segmentId?: string | null;
    lifecycleStage?: number | null;
    contentType?: string | null;
    channel?: string;
  } = {}
): Promise<Row | null> {
  const {
    targetTypeId = null,
    segmentId = null,
    lifecycleStage = null,
    contentType = null,
    channel = "email",
  } = opts;

  const rows = await sql`
    SELECT * FROM content
    WHERE organization_id = ${orgId}
      AND channel = ${channel}
      AND status = 'active'
      AND (target_type_id IS NULL OR target_type_id = ${targetTypeId}::uuid)
      AND (segment_id IS NULL OR segment_id = ${segmentId}::uuid)
      AND (lifecycle_stage IS NULL OR lifecycle_stage = ${lifecycleStage})
      AND (${contentType}::text IS NULL OR content_type = ${contentType})
    ORDER BY
      (target_type_id = ${targetTypeId}::uuid)::int +
      (segment_id = ${segmentId}::uuid)::int +
      (lifecycle_stage = ${lifecycleStage})::int DESC,
      created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}
