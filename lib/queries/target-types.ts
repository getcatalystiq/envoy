import { sql, getPool } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export async function getAll(
  orgId: string,
  opts: {
    limit?: number;
    offset?: number;
  } = {}
): Promise<Row[]> {
  const { limit = 100, offset = 0 } = opts;

  return sql`
    SELECT id, organization_id, name, description, lifecycle_stages, created_at
    FROM target_types
    WHERE organization_id = ${orgId}
    ORDER BY name ASC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

export async function getById(
  orgId: string,
  typeId: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT id, organization_id, name, description, lifecycle_stages, created_at
    FROM target_types
    WHERE id = ${typeId}::uuid AND organization_id = ${orgId}
  `;
  return rows[0] ?? null;
}

export async function getByName(
  orgId: string,
  name: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT id, organization_id, name, description, lifecycle_stages, created_at
    FROM target_types
    WHERE organization_id = ${orgId} AND name = ${name}
  `;
  return rows[0] ?? null;
}

export async function create(
  orgId: string,
  data: {
    name: string;
    description?: string | null;
  }
): Promise<Row> {
  const rows = await sql`
    INSERT INTO target_types (organization_id, name, description)
    VALUES (${orgId}, ${data.name}, ${data.description ?? null})
    RETURNING id, organization_id, name, description, lifecycle_stages, created_at
  `;
  return rows[0];
}

export async function update(
  orgId: string,
  typeId: string,
  fields: {
    name?: string;
    description?: string;
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

  if (setClauses.length === 0) {
    return getById(orgId, typeId);
  }

  values.push(typeId);
  values.push(orgId);

  const query = `
    UPDATE target_types
    SET ${setClauses.join(", ")}
    WHERE id = $${idx}::uuid AND organization_id = $${idx + 1}
    RETURNING id, organization_id, name, description, lifecycle_stages, created_at
  `;

  const { rows } = await getPool().query(query, values);
  return rows[0] ?? null;
}

export async function deleteTargetType(
  orgId: string,
  typeId: string
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM target_types
    WHERE id = ${typeId}::uuid AND organization_id = ${orgId}
  `;
  return rows.length === 1;
}

export async function getUsageCount(
  typeId: string
): Promise<{ segments: number; targets: number; sequences: number; content: number }> {
  const [segmentsRows, targetsRows, sequencesRows, contentRows] = await Promise.all([
    sql`SELECT COUNT(*)::int as count FROM segments WHERE target_type_id = ${typeId}::uuid`,
    sql`SELECT COUNT(*)::int as count FROM targets WHERE target_type_id = ${typeId}::uuid`,
    sql`SELECT COUNT(*)::int as count FROM sequences WHERE target_type_id = ${typeId}::uuid`,
    sql`SELECT COUNT(*)::int as count FROM content WHERE target_type_id = ${typeId}::uuid`,
  ]);

  return {
    segments: segmentsRows[0]?.count ?? 0,
    targets: targetsRows[0]?.count ?? 0,
    sequences: sequencesRows[0]?.count ?? 0,
    content: contentRows[0]?.count ?? 0,
  };
}
