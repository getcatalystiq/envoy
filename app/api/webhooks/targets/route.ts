import { verifyWebhookSecret } from "@/lib/webhook-auth";
import { jsonResponse } from "@/lib/utils";
import { sql } from "@/lib/db";

interface TargetPayload {
  email?: string;
  phone?: string;
  target_type?: string;
  segment?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  lifecycle_stage?: number;
  custom_fields?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

function parseJsonFields(val: unknown): Record<string, unknown> {
  if (val == null) return {};
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {};
}

async function resolveTargetType(
  orgId: string,
  name: string | undefined,
): Promise<string | null> {
  if (!name) return null;
  const rows = await sql`
    SELECT id FROM target_types WHERE organization_id = ${orgId} AND LOWER(name) = LOWER(${name})
  `;
  return rows.length > 0 ? rows[0].id : null;
}

async function resolveSegment(
  orgId: string,
  name: string | undefined,
): Promise<string | null> {
  if (!name) return null;
  const rows = await sql`
    SELECT id FROM segments WHERE organization_id = ${orgId} AND LOWER(name) = LOWER(${name})
  `;
  return rows.length > 0 ? rows[0].id : null;
}

async function upsertTarget(
  orgId: string,
  payload: TargetPayload,
  targetTypeId: string | null,
  segmentId: string | null,
): Promise<{
  target: Record<string, unknown>;
  action: string;
  matchedOn: string | null;
}> {
  const customFields = parseJsonFields(payload.custom_fields);
  const metadata = parseJsonFields(payload.metadata);

  // Try match on email first, then phone
  let existing: Record<string, unknown>[] = [];
  let matchedOn: string | null = null;

  if (payload.email) {
    existing = await sql`
      SELECT * FROM targets WHERE organization_id = ${orgId} AND email = ${payload.email}
    `;
    if (existing.length > 0) matchedOn = "email";
  }

  if (existing.length === 0 && payload.phone) {
    existing = await sql`
      SELECT * FROM targets WHERE organization_id = ${orgId} AND phone = ${payload.phone}
    `;
    if (existing.length > 0) matchedOn = "phone";
  }

  if (existing.length > 0) {
    // Update existing target
    const target = existing[0];
    const mergedCustom = { ...(target.custom_fields as Record<string, unknown> ?? {}), ...customFields };
    const mergedMeta = { ...(target.metadata as Record<string, unknown> ?? {}), ...metadata };

    const updated = await sql`
      UPDATE targets SET
        first_name = COALESCE(${payload.first_name ?? null}, first_name),
        last_name = COALESCE(${payload.last_name ?? null}, last_name),
        company = COALESCE(${payload.company ?? null}, company),
        phone = COALESCE(${payload.phone ?? null}, phone),
        email = COALESCE(${payload.email ?? null}, email),
        target_type_id = COALESCE(${targetTypeId}, target_type_id),
        segment_id = COALESCE(${segmentId}, segment_id),
        lifecycle_stage = COALESCE(${payload.lifecycle_stage ?? null}, lifecycle_stage),
        custom_fields = ${JSON.stringify(mergedCustom)},
        metadata = ${JSON.stringify(mergedMeta)},
        updated_at = NOW()
      WHERE id = ${target.id as string}
      RETURNING *
    `;

    return { target: updated[0], action: "updated", matchedOn };
  }

  // Create new target
  const created = await sql`
    INSERT INTO targets (
      organization_id, email, phone, first_name, last_name, company,
      target_type_id, segment_id, lifecycle_stage, custom_fields, metadata
    ) VALUES (
      ${orgId}, ${payload.email ?? null}, ${payload.phone ?? null},
      ${payload.first_name ?? null}, ${payload.last_name ?? null}, ${payload.company ?? null},
      ${targetTypeId}, ${segmentId}, ${payload.lifecycle_stage ?? 0},
      ${JSON.stringify(customFields)}, ${JSON.stringify(metadata)}
    )
    RETURNING *
  `;

  return { target: created[0], action: "created", matchedOn: null };
}

async function autoEnrollInDefaultSequence(
  orgId: string,
  targetId: string,
  targetTypeId: string,
) {
  const sequences = await sql`
    SELECT id FROM sequences
    WHERE organization_id = ${orgId}
      AND target_type_id = ${targetTypeId}
      AND is_default = true
      AND status = 'active'
  `;

  for (const seq of sequences) {
    const existing = await sql`
      SELECT id FROM sequence_enrollments
      WHERE sequence_id = ${seq.id} AND target_id = ${targetId}
    `;
    if (existing.length === 0) {
      await sql`
        INSERT INTO sequence_enrollments (sequence_id, target_id, organization_id, status, current_step_index)
        VALUES (${seq.id}, ${targetId}, ${orgId}, 'active', 0)
      `;
    }
  }
}

function hasGraduationRelevantFields(payload: TargetPayload): boolean {
  return !!(
    (payload.metadata && Object.keys(payload.metadata).length > 0) ||
    (payload.custom_fields && Object.keys(payload.custom_fields).length > 0) ||
    payload.lifecycle_stage !== undefined
  );
}

/** POST /api/webhooks/targets — ingest a single target */
export async function POST(request: Request) {
  const orgId = request.headers.get("x-organization-id");
  const webhookSecret = request.headers.get("x-webhook-secret");

  if (!orgId) {
    return jsonResponse({ error: "X-Organization-Id header required" }, 400);
  }
  if (!webhookSecret) {
    return jsonResponse({ error: "X-Webhook-Secret header required" }, 400);
  }

  const authError = await verifyWebhookSecret(orgId, webhookSecret);
  if (authError) return authError;

  const payload: TargetPayload = await request.json();

  if (!payload.email && !payload.phone) {
    return jsonResponse(
      { error: "At least one of email or phone is required" },
      400,
    );
  }

  const [targetTypeId, segmentId] = await Promise.all([
    resolveTargetType(orgId, payload.target_type),
    resolveSegment(orgId, payload.segment),
  ]);

  const { target, action, matchedOn } = await upsertTarget(
    orgId,
    payload,
    targetTypeId,
    segmentId,
  );

  // Auto-enroll in default sequence for new targets
  if (action === "created" && targetTypeId) {
    await autoEnrollInDefaultSequence(
      orgId,
      target.id as string,
      targetTypeId,
    );
  }

  // Evaluate graduation rules if relevant
  if (target.target_type_id && hasGraduationRelevantFields(payload)) {
    try {
      const { evaluateAndGraduate } = await import("@/lib/graduation");
      await evaluateAndGraduate(orgId, target.id as string);
    } catch {
      // Non-fatal: log but don't fail the webhook
    }
  }

  return jsonResponse(
    { id: target.id, action, matched_on: matchedOn },
    action === "created" ? 201 : 200,
  );
}
