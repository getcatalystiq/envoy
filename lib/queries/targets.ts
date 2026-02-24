import { sql, getPool } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/**
 * Normalize a phone number by stripping non-digit characters (keeping leading +).
 * Returns null if the result is too short to be valid.
 */
function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  return digits.length >= 7 ? digits : null;
}

export async function getAll(
  orgId: string,
  opts: {
    status?: string;
    targetTypeId?: string;
    segmentId?: string;
    lifecycleStage?: number;
    limit?: number;
    offset?: number;
  } = {}
): Promise<Row[]> {
  const { status, targetTypeId, segmentId, lifecycleStage, limit = 100, offset = 0 } = opts;

  const rows = await sql`
    SELECT * FROM targets
    WHERE organization_id = ${orgId}
      AND (${status ?? null}::text IS NULL OR status = ${status ?? null})
      AND (${targetTypeId ?? null}::uuid IS NULL OR target_type_id = ${targetTypeId ?? null}::uuid)
      AND (${segmentId ?? null}::uuid IS NULL OR segment_id = ${segmentId ?? null}::uuid)
      AND (${lifecycleStage ?? null}::int IS NULL OR lifecycle_stage = ${lifecycleStage ?? null})
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows;
}

export async function getById(
  orgId: string,
  targetId: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT * FROM targets
    WHERE id = ${targetId}::uuid AND organization_id = ${orgId}
  `;
  return rows[0] ?? null;
}

export async function getByEmail(
  orgId: string,
  email: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT * FROM targets
    WHERE organization_id = ${orgId} AND email = ${email}
  `;
  return rows[0] ?? null;
}

export async function getByPhone(
  orgId: string,
  phoneNormalized: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT * FROM targets
    WHERE organization_id = ${orgId} AND phone_normalized = ${phoneNormalized}
  `;
  return rows[0] ?? null;
}

export async function create(
  orgId: string,
  data: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    targetTypeId?: string | null;
    segmentId?: string | null;
    lifecycleStage?: number;
    customFields?: Record<string, unknown>;
  }
): Promise<Row> {
  const rows = await sql`
    INSERT INTO targets (
      organization_id, email, first_name, last_name, company,
      target_type_id, segment_id, lifecycle_stage, custom_fields
    ) VALUES (
      ${orgId},
      ${data.email},
      ${data.firstName ?? null},
      ${data.lastName ?? null},
      ${data.company ?? null},
      ${data.targetTypeId ?? null}::uuid,
      ${data.segmentId ?? null}::uuid,
      ${data.lifecycleStage ?? 0},
      ${JSON.stringify(data.customFields ?? {})}::jsonb
    )
    RETURNING *
  `;
  return rows[0];
}

export async function update(
  orgId: string,
  targetId: string,
  fields: Record<string, unknown>
): Promise<Row | null> {
  if (!fields || Object.keys(fields).length === 0) {
    return getById(orgId, targetId);
  }

  // Build SET clauses dynamically
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      setClauses.push(`${key} = $${idx}`);
      values.push(key === "custom_fields" || key === "metadata" ? JSON.stringify(value) : value);
      idx++;
    }
  }

  if (setClauses.length === 0) {
    return getById(orgId, targetId);
  }

  setClauses.push("updated_at = NOW()");
  values.push(targetId);
  values.push(orgId);

  // Use raw query for dynamic SET clause
  const query = `
    UPDATE targets
    SET ${setClauses.join(", ")}
    WHERE id = $${idx}::uuid AND organization_id = $${idx + 1}
    RETURNING *
  `;

  const { rows } = await getPool().query(query, values);
  return rows[0] ?? null;
}

export async function updateStatus(
  email: string,
  status: string
): Promise<number> {
  const rows = await sql`
    UPDATE targets
    SET status = ${status}, updated_at = NOW()
    WHERE email = ${email} AND status = 'active'
  `;
  return rows.length;
}

export async function deleteTarget(
  orgId: string,
  targetId: string
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM targets
    WHERE id = ${targetId}::uuid AND organization_id = ${orgId}
  `;
  return rows.length === 1;
}

export async function count(
  orgId: string,
  status?: string
): Promise<number> {
  if (status) {
    const rows = await sql`
      SELECT COUNT(*)::int as count FROM targets
      WHERE organization_id = ${orgId} AND status = ${status}
    `;
    return rows[0]?.count ?? 0;
  }
  const rows = await sql`
    SELECT COUNT(*)::int as count FROM targets
    WHERE organization_id = ${orgId}
  `;
  return rows[0]?.count ?? 0;
}

export async function findByEmailOrPhone(
  orgId: string,
  email?: string | null,
  phone?: string | null
): Promise<{ target: Row | null; matchedOn: string | null }> {
  if (email) {
    const target = await getByEmail(orgId, email);
    if (target) return { target, matchedOn: "email" };
  }

  if (phone) {
    const phoneNormalized = normalizePhone(phone);
    if (phoneNormalized) {
      const target = await getByPhone(orgId, phoneNormalized);
      if (target) return { target, matchedOn: "phone" };
    }
  }

  return { target: null, matchedOn: null };
}

export async function upsert(
  orgId: string,
  data: {
    email?: string | null;
    phone?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    targetTypeId?: string | null;
    segmentId?: string | null;
    lifecycleStage?: number | null;
    customFields?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
  }
): Promise<{ target: Row; action: string; matchedOn: string | null }> {
  const phoneNormalized = normalizePhone(data.phone);

  // Find existing target
  const { target: existing, matchedOn } = await findByEmailOrPhone(
    orgId,
    data.email,
    data.phone
  );

  if (existing) {
    // Update existing target
    const updateFields: Record<string, unknown> = {};

    // Update email if provided and target was matched by phone
    if (data.email && matchedOn === "phone" && !existing.email) {
      updateFields.email = data.email;
    }

    // Update phone if provided and different
    if (data.phone && data.phone !== existing.phone) {
      updateFields.phone = data.phone;
      updateFields.phone_normalized = phoneNormalized;
    }

    if (data.firstName) updateFields.first_name = data.firstName;
    if (data.lastName) updateFields.last_name = data.lastName;
    if (data.company) updateFields.company = data.company;
    if (data.targetTypeId) updateFields.target_type_id = data.targetTypeId;
    if (data.segmentId) updateFields.segment_id = data.segmentId;
    if (data.lifecycleStage !== undefined && data.lifecycleStage !== null) {
      updateFields.lifecycle_stage = data.lifecycleStage;
    }

    if (data.customFields) {
      const existingCustom = (typeof existing.custom_fields === "string"
        ? JSON.parse(existing.custom_fields)
        : existing.custom_fields) ?? {};
      updateFields.custom_fields = { ...existingCustom, ...data.customFields };
    }

    if (data.metadata) {
      const existingMeta = (typeof existing.metadata === "string"
        ? JSON.parse(existing.metadata)
        : existing.metadata) ?? {};
      updateFields.metadata = { ...existingMeta, ...data.metadata };
    }

    if (Object.keys(updateFields).length > 0) {
      const updated = await update(orgId, existing.id, updateFields);
      return { target: updated ?? existing, action: "updated", matchedOn };
    }
    return { target: existing, action: "updated", matchedOn };
  }

  // Create new target
  if (!data.email) {
    throw new Error("Email is required when creating a new target");
  }

  const rows = await sql`
    INSERT INTO targets (
      organization_id, email, phone, phone_normalized,
      first_name, last_name, company,
      target_type_id, segment_id, lifecycle_stage, custom_fields, metadata
    ) VALUES (
      ${orgId},
      ${data.email},
      ${data.phone ?? null},
      ${phoneNormalized},
      ${data.firstName ?? null},
      ${data.lastName ?? null},
      ${data.company ?? null},
      ${data.targetTypeId ?? null}::uuid,
      ${data.segmentId ?? null}::uuid,
      ${data.lifecycleStage ?? 0},
      ${JSON.stringify(data.customFields ?? {})}::jsonb,
      ${JSON.stringify(data.metadata ?? {})}::jsonb
    )
    RETURNING *
  `;
  return { target: rows[0], action: "created", matchedOn: null };
}

export async function bulkUpsert(
  orgId: string,
  targets: Array<{
    email?: string | null;
    phone?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    targetTypeId?: string | null;
    segmentId?: string | null;
    lifecycleStage?: number | null;
    customFields?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
  }>
): Promise<{ created: number; updated: number; errors: Array<{ index: number; error: string }> }> {
  let created = 0;
  let updated = 0;
  const errors: Array<{ index: number; error: string }> = [];

  for (let i = 0; i < targets.length; i++) {
    try {
      const result = await upsert(orgId, targets[i]);
      if (result.action === "created") {
        created++;
      } else {
        updated++;
      }
    } catch (e) {
      errors.push({ index: i, error: String(e) });
    }
  }

  return { created, updated, errors };
}
