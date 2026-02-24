import { sql, getPool } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function parseArrays(row: Row): Row {
  if (row.pain_points == null) row.pain_points = [];
  if (row.objections == null) row.objections = [];
  return row;
}

export async function getAll(
  orgId: string,
  opts: {
    targetTypeId?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<Row[]> {
  const { targetTypeId, limit = 100, offset = 0 } = opts;

  if (targetTypeId) {
    const rows = await sql`
      SELECT s.id, s.organization_id, s.target_type_id, s.name, s.description,
             s.pain_points, s.objections, s.created_at,
             t.name as target_type_name
      FROM segments s
      LEFT JOIN target_types t ON s.target_type_id = t.id
      WHERE s.organization_id = ${orgId} AND s.target_type_id = ${targetTypeId}::uuid
      ORDER BY s.name ASC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map(parseArrays);
  }

  const rows = await sql`
    SELECT s.id, s.organization_id, s.target_type_id, s.name, s.description,
           s.pain_points, s.objections, s.created_at,
           t.name as target_type_name
    FROM segments s
    LEFT JOIN target_types t ON s.target_type_id = t.id
    WHERE s.organization_id = ${orgId}
    ORDER BY s.name ASC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows.map(parseArrays);
}

export async function getById(
  orgId: string,
  segmentId: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT s.id, s.organization_id, s.target_type_id, s.name, s.description,
           s.pain_points, s.objections, s.created_at,
           t.name as target_type_name
    FROM segments s
    LEFT JOIN target_types t ON s.target_type_id = t.id
    WHERE s.id = ${segmentId}::uuid AND s.organization_id = ${orgId}
  `;
  if (rows.length === 0) return null;
  return parseArrays(rows[0]);
}

export async function getByName(
  orgId: string,
  targetTypeId: string,
  name: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT s.id, s.organization_id, s.target_type_id, s.name, s.description,
           s.pain_points, s.objections, s.created_at,
           t.name as target_type_name
    FROM segments s
    LEFT JOIN target_types t ON s.target_type_id = t.id
    WHERE s.target_type_id = ${targetTypeId}::uuid AND s.name = ${name}
      AND s.organization_id = ${orgId}
  `;
  if (rows.length === 0) return null;
  return parseArrays(rows[0]);
}

export async function create(
  orgId: string,
  data: {
    targetTypeId: string;
    name: string;
    description?: string | null;
    painPoints?: string[] | null;
    objections?: string[] | null;
  }
): Promise<Row> {
  const rows = await sql`
    INSERT INTO segments (organization_id, target_type_id, name, description, pain_points, objections)
    VALUES (
      ${orgId},
      ${data.targetTypeId}::uuid,
      ${data.name},
      ${data.description ?? null},
      ${data.painPoints ?? []}::text[],
      ${data.objections ?? []}::text[]
    )
    RETURNING id, organization_id, target_type_id, name, description, pain_points, objections, created_at
  `;
  const result = parseArrays(rows[0]);

  // Fetch target type name
  const ttRows = await sql`
    SELECT name FROM target_types WHERE id = ${data.targetTypeId}::uuid
  `;
  result.target_type_name = ttRows[0]?.name ?? null;

  return result;
}

export async function update(
  orgId: string,
  segmentId: string,
  fields: {
    name?: string;
    description?: string;
    targetTypeId?: string;
    painPoints?: string[];
    objections?: string[];
  }
): Promise<Row | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (fields.name !== undefined) {
    setClauses.push(`name = $${idx}`);
    values.push(fields.name);
    idx++;
  }
  if (fields.description !== undefined) {
    setClauses.push(`description = $${idx}`);
    values.push(fields.description);
    idx++;
  }
  if (fields.targetTypeId !== undefined) {
    setClauses.push(`target_type_id = $${idx}::uuid`);
    values.push(fields.targetTypeId);
    idx++;
  }
  if (fields.painPoints !== undefined) {
    setClauses.push(`pain_points = $${idx}::text[]`);
    values.push(fields.painPoints);
    idx++;
  }
  if (fields.objections !== undefined) {
    setClauses.push(`objections = $${idx}::text[]`);
    values.push(fields.objections);
    idx++;
  }

  if (setClauses.length === 0) {
    return getById(orgId, segmentId);
  }

  values.push(segmentId);
  values.push(orgId);

  const query = `
    UPDATE segments
    SET ${setClauses.join(", ")}
    WHERE id = $${idx}::uuid AND organization_id = $${idx + 1}
    RETURNING id, organization_id, target_type_id, name, description, pain_points, objections, created_at
  `;

  const { rows } = await getPool().query(query, values);
  if (rows.length === 0) return null;

  const result = parseArrays(rows[0]);

  // Fetch target type name
  const ttRows = await sql`
    SELECT name FROM target_types WHERE id = ${result.target_type_id}::uuid
  `;
  result.target_type_name = ttRows[0]?.name ?? null;

  return result;
}

export async function deleteSegment(
  orgId: string,
  segmentId: string
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM segments
    WHERE id = ${segmentId}::uuid AND organization_id = ${orgId}
  `;
  return rows.length === 1;
}

export async function getUsageCount(
  segmentId: string
): Promise<{ targets: number; content: number }> {
  const [targetsRows, contentRows] = await Promise.all([
    sql`SELECT COUNT(*)::int as count FROM targets WHERE segment_id = ${segmentId}::uuid`,
    sql`SELECT COUNT(*)::int as count FROM content WHERE segment_id = ${segmentId}::uuid`,
  ]);

  return {
    targets: targetsRows[0]?.count ?? 0,
    content: contentRows[0]?.count ?? 0,
  };
}

export async function countByTargetType(
  targetTypeId: string
): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*)::int as count FROM segments WHERE target_type_id = ${targetTypeId}::uuid
  `;
  return rows[0]?.count ?? 0;
}
