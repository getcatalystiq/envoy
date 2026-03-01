import { verifyWebhookSecret } from "@/lib/webhook-auth";
import { jsonResponse } from "@/lib/utils";
import { sql } from "@/lib/db";
import { autoEnrollInDefaultSequences } from "@/lib/queries/sequences";

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
}> {
  const customFields = parseJsonFields(payload.custom_fields);
  const metadata = parseJsonFields(payload.metadata);

  let existing: Record<string, unknown>[] = [];

  if (payload.email) {
    existing = await sql`
      SELECT * FROM targets WHERE organization_id = ${orgId} AND email = ${payload.email}
    `;
  }

  if (existing.length === 0 && payload.phone) {
    existing = await sql`
      SELECT * FROM targets WHERE organization_id = ${orgId} AND phone = ${payload.phone}
    `;
  }

  if (existing.length > 0) {
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

    return { target: updated[0], action: "updated" };
  }

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

  return { target: created[0], action: "created" };
}


/** POST /api/webhooks/targets/bulk — bulk ingest up to 100 targets */
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

  const body = await request.json();
  const targets: TargetPayload[] = body.targets;

  if (!Array.isArray(targets) || targets.length === 0) {
    return jsonResponse({ error: "targets array is required" }, 400);
  }
  if (targets.length > 100) {
    return jsonResponse({ error: "Maximum 100 targets per bulk request" }, 400);
  }

  let created = 0;
  let updated = 0;
  const errors: { index: number; email?: string; phone?: string; error: string }[] = [];

  for (let i = 0; i < targets.length; i++) {
    const payload = targets[i];
    try {
      if (!payload.email && !payload.phone) {
        throw new Error("At least one of email or phone is required");
      }

      const [targetTypeId, segmentId] = await Promise.all([
        resolveTargetType(orgId, payload.target_type),
        resolveSegment(orgId, payload.segment),
      ]);

      const result = await upsertTarget(orgId, payload, targetTypeId, segmentId);

      if (result.action === "created" && targetTypeId) {
        await autoEnrollInDefaultSequences(
          orgId,
          result.target.id as string,
          targetTypeId,
        );
      }

      // Evaluate graduation rules
      if (
        result.target.target_type_id &&
        (payload.metadata || payload.custom_fields || payload.lifecycle_stage !== undefined)
      ) {
        try {
          const { evaluateAndGraduate } = await import("@/lib/graduation");
          await evaluateAndGraduate(orgId, result.target.id as string);
        } catch {
          // Non-fatal
        }
      }

      if (result.action === "created") created++;
      else updated++;
    } catch (e) {
      errors.push({
        index: i,
        email: payload.email,
        phone: payload.phone,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return jsonResponse({ created, updated, errors });
}
