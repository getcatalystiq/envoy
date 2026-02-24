import { sql, getPool } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export async function getAll(
  orgId: string,
  opts: { includeArchived?: boolean } = {}
): Promise<Row[]> {
  const { includeArchived = false } = opts;

  if (includeArchived) {
    return sql`
      SELECT id, organization_id, name, description,
             builder_content, html_compiled, archived,
             created_at, updated_at
      FROM design_templates
      WHERE organization_id = ${orgId}
      ORDER BY created_at DESC
    `;
  }

  return sql`
    SELECT id, organization_id, name, description,
           builder_content, html_compiled, archived,
           created_at, updated_at
    FROM design_templates
    WHERE organization_id = ${orgId} AND archived = FALSE
    ORDER BY created_at DESC
  `;
}

export async function getById(
  orgId: string,
  templateId: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT id, organization_id, name, description,
           builder_content, html_compiled, archived,
           created_at, updated_at
    FROM design_templates
    WHERE id = ${templateId}::uuid AND organization_id = ${orgId}
  `;
  return rows[0] ?? null;
}

export async function create(
  orgId: string,
  data: {
    name: string;
    builderContent?: Record<string, unknown> | null;
    htmlCompiled?: string | null;
    description?: string | null;
  }
): Promise<Row> {
  const builderJson = data.builderContent ? JSON.stringify(data.builderContent) : null;

  const rows = await sql`
    INSERT INTO design_templates (
      organization_id, name, description,
      builder_content, html_compiled
    )
    VALUES (
      ${orgId},
      ${data.name},
      ${data.description ?? null},
      ${builderJson}::jsonb,
      ${data.htmlCompiled ?? null}
    )
    RETURNING id, organization_id, name, description,
              builder_content, html_compiled, archived,
              created_at, updated_at
  `;
  return rows[0];
}

export async function update(
  orgId: string,
  templateId: string,
  fields: {
    name?: string;
    description?: string;
    builderContent?: Record<string, unknown>;
    htmlCompiled?: string;
    archived?: boolean;
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
  if (fields.builderContent !== undefined) {
    setClauses.push(`builder_content = $${idx}::jsonb`);
    values.push(JSON.stringify(fields.builderContent));
    idx++;
  }
  if (fields.htmlCompiled !== undefined) {
    setClauses.push(`html_compiled = $${idx}`);
    values.push(fields.htmlCompiled);
    idx++;
  }
  if (fields.archived !== undefined) {
    setClauses.push(`archived = $${idx}`);
    values.push(fields.archived);
    idx++;
  }

  if (setClauses.length === 0) {
    return getById(orgId, templateId);
  }

  values.push(templateId);
  values.push(orgId);

  const query = `
    UPDATE design_templates
    SET ${setClauses.join(", ")}
    WHERE id = $${idx}::uuid AND organization_id = $${idx + 1}
    RETURNING id, organization_id, name, description,
              builder_content, html_compiled, archived,
              created_at, updated_at
  `;

  const { rows } = await getPool().query(query, values);
  return rows[0] ?? null;
}

export async function deleteTemplate(
  orgId: string,
  templateId: string
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM design_templates
    WHERE id = ${templateId}::uuid AND organization_id = ${orgId}
  `;
  return rows.length === 1;
}
