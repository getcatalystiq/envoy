import { sql } from "@/lib/db";
import { withTransaction } from "@/lib/db";
import type { PoolClient } from "@neondatabase/serverless";

const ALLOWED_ROOT_FIELDS = new Set([
  "status",
  "lifecycle_stage",
  "email",
  "first_name",
  "last_name",
  "company",
  "phone",
  "title",
  "industry",
  "custom_fields",
  "metadata",
]);

const MAX_FIELD_DEPTH = 3;

export class GraduationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraduationError";
  }
}

export class TargetNotFoundError extends GraduationError {
  constructor(message: string) {
    super(message);
    this.name = "TargetNotFoundError";
  }
}

export class UnauthorizedError extends GraduationError {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class InvalidRuleError extends GraduationError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRuleError";
  }
}

function getFieldValue(
  target: Record<string, unknown>,
  field: string,
): unknown {
  const parts = field.split(".");

  if (parts.length > MAX_FIELD_DEPTH) {
    throw new InvalidRuleError(`Field path too deep: ${field}`);
  }

  if (!ALLOWED_ROOT_FIELDS.has(parts[0])) {
    throw new InvalidRuleError(`Field not allowed: ${parts[0]}`);
  }

  for (const part of parts) {
    if (part.startsWith("_")) {
      throw new InvalidRuleError(`Private field access forbidden: ${part}`);
    }
  }

  let current: unknown = target;
  for (const part of parts) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return null;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current ?? null;
}

export function evaluateCondition(
  target: Record<string, unknown>,
  condition: { field: string; operator: string; value?: unknown },
): boolean {
  const { field = "", operator = "eq", value: expected } = condition;
  const actual = getFieldValue(target, field);

  if (operator === "exists") {
    return actual !== null;
  }

  if (actual === null) return false;

  switch (operator) {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "gt":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual > expected
      );
    case "gte":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual >= expected
      );
    case "lt":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual < expected
      );
    case "lte":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual <= expected
      );
    case "contains":
      if (typeof actual === "string") {
        return typeof expected === "string" && actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return actual.includes(expected);
      }
      return false;
    default:
      throw new InvalidRuleError(`Unknown operator: ${operator}`);
  }
}

export function evaluateRule(
  target: Record<string, unknown>,
  conditions: Array<{ field: string; operator: string; value?: unknown }>,
): boolean {
  if (!conditions || conditions.length === 0) return false;
  return conditions.every((c) => evaluateCondition(target, c));
}

export async function findMatchingRule(
  orgId: string,
  target: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const targetTypeId = target.target_type_id;
  if (!targetTypeId) return null;

  const rules = await sql`
    SELECT * FROM graduation_rules
    WHERE organization_id = ${orgId}
      AND source_target_type_id = ${targetTypeId}
      AND enabled = TRUE
    ORDER BY created_at
  `;

  const evalTarget: Record<string, unknown> = {
    ...target,
    custom_fields:
      (target.custom_fields as Record<string, unknown>) ?? {},
    metadata: (target.metadata as Record<string, unknown>) ?? {},
  };

  for (const rule of rules) {
    const conditions = rule.conditions as Array<{
      field: string;
      operator: string;
      value?: unknown;
    }>;
    if (conditions && evaluateRule(evalTarget, conditions)) {
      return rule as Record<string, unknown>;
    }
  }

  return null;
}

export async function graduateTarget(opts: {
  orgId: string;
  targetId: string;
  destinationTypeId: string;
  userId?: string;
  ruleId?: string;
}): Promise<Record<string, unknown>> {
  const { orgId, targetId, destinationTypeId, userId, ruleId } = opts;

  return withTransaction(async (client: PoolClient) => {
    // Get and lock the target
    const targetResult = await client.query(
      "SELECT * FROM targets WHERE id = $1 FOR UPDATE",
      [targetId],
    );
    const target = targetResult.rows[0];

    if (!target) {
      throw new TargetNotFoundError(`Target not found: ${targetId}`);
    }

    if (String(target.organization_id) !== orgId) {
      throw new UnauthorizedError(
        `Target ${targetId} does not belong to organization`,
      );
    }

    const sourceTypeId = target.target_type_id;

    if (sourceTypeId === destinationTypeId) {
      throw new GraduationError("Target is already in the destination type");
    }

    // Verify destination type exists and belongs to org
    const destResult = await client.query(
      "SELECT id FROM target_types WHERE id = $1 AND organization_id = $2",
      [destinationTypeId, orgId],
    );
    if (destResult.rows.length === 0) {
      throw new GraduationError(
        `Invalid destination type: ${destinationTypeId}`,
      );
    }

    // 1. Exit all active sequence enrollments
    await client.query(
      `UPDATE sequence_enrollments
       SET status = 'exited', exit_reason = 'graduated', updated_at = NOW()
       WHERE organization_id = $1 AND target_id = $2
         AND status IN ('active', 'paused')`,
      [orgId, targetId],
    );

    // 2. Update target type
    await client.query(
      "UPDATE targets SET target_type_id = $1, segment_id = NULL, updated_at = NOW() WHERE id = $2",
      [destinationTypeId, targetId],
    );

    // 3. Auto-enroll in default sequences for new type
    const defaultSequences = await client.query(
      `SELECT id FROM sequences
       WHERE organization_id = $1
         AND target_type_id = $2
         AND is_default = TRUE
         AND status = 'active'`,
      [orgId, destinationTypeId],
    );

    for (const seq of defaultSequences.rows) {
      // Check not already enrolled
      const existing = await client.query(
        `SELECT id FROM sequence_enrollments
         WHERE organization_id = $1 AND target_id = $2 AND sequence_id = $3
           AND status IN ('active', 'paused')`,
        [orgId, targetId, seq.id],
      );
      if (existing.rows.length === 0) {
        await client.query(
          `INSERT INTO sequence_enrollments (organization_id, target_id, sequence_id, status)
           VALUES ($1, $2, $3, 'active')`,
          [orgId, targetId, seq.id],
        );
      }
    }

    // 4. Record the graduation event
    const eventResult = await client.query(
      `INSERT INTO graduation_events
         (organization_id, target_id, rule_id, source_target_type_id,
          destination_target_type_id, manual, triggered_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        orgId,
        targetId,
        ruleId ?? null,
        sourceTypeId,
        destinationTypeId,
        userId != null && ruleId == null,
        userId ?? null,
      ],
    );

    return eventResult.rows[0] as Record<string, unknown>;
  });
}

export async function evaluateAndGraduate(
  orgId: string,
  targetId: string,
): Promise<Record<string, unknown> | null> {
  return withTransaction(async (client: PoolClient) => {
    // Lock the target row to prevent concurrent graduation attempts
    const targetResult = await client.query(
      "SELECT * FROM targets WHERE id = $1 FOR UPDATE",
      [targetId],
    );
    const target = targetResult.rows[0];

    if (!target) {
      throw new TargetNotFoundError(`Target not found: ${targetId}`);
    }

    const targetDict = target as Record<string, unknown>;

    if (String(targetDict.organization_id) !== orgId) {
      throw new UnauthorizedError(
        `Target ${targetId} does not belong to organization`,
      );
    }

    const rule = await findMatchingRule(orgId, targetDict);
    if (!rule) return null;

    // Call graduateTarget which uses its own transaction — but we're already
    // in one here, so call the inner logic directly
    const sourceTypeId = targetDict.target_type_id;
    const destinationTypeId = rule.destination_target_type_id as string;

    if (sourceTypeId === destinationTypeId) {
      throw new GraduationError("Target is already in the destination type");
    }

    // Verify destination type
    const destResult = await client.query(
      "SELECT id FROM target_types WHERE id = $1 AND organization_id = $2",
      [destinationTypeId, orgId],
    );
    if (destResult.rows.length === 0) {
      throw new GraduationError(
        `Invalid destination type: ${destinationTypeId}`,
      );
    }

    // 1. Exit active enrollments
    await client.query(
      `UPDATE sequence_enrollments
       SET status = 'exited', exit_reason = 'graduated', updated_at = NOW()
       WHERE organization_id = $1 AND target_id = $2
         AND status IN ('active', 'paused')`,
      [orgId, targetId],
    );

    // 2. Update target type
    await client.query(
      "UPDATE targets SET target_type_id = $1, segment_id = NULL, updated_at = NOW() WHERE id = $2",
      [destinationTypeId, targetId],
    );

    // 3. Auto-enroll in default sequences
    const defaultSequences = await client.query(
      `SELECT id FROM sequences
       WHERE organization_id = $1 AND target_type_id = $2
         AND is_default = TRUE AND status = 'active'`,
      [orgId, destinationTypeId],
    );

    for (const seq of defaultSequences.rows) {
      const existing = await client.query(
        `SELECT id FROM sequence_enrollments
         WHERE organization_id = $1 AND target_id = $2 AND sequence_id = $3
           AND status IN ('active', 'paused')`,
        [orgId, targetId, seq.id],
      );
      if (existing.rows.length === 0) {
        await client.query(
          `INSERT INTO sequence_enrollments (organization_id, target_id, sequence_id, status)
           VALUES ($1, $2, $3, 'active')`,
          [orgId, targetId, seq.id],
        );
      }
    }

    // 4. Record graduation event
    const eventResult = await client.query(
      `INSERT INTO graduation_events
         (organization_id, target_id, rule_id, source_target_type_id,
          destination_target_type_id, manual, triggered_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        orgId,
        targetId,
        (rule.id as string) ?? null,
        sourceTypeId,
        destinationTypeId,
        false,
        null,
      ],
    );

    return eventResult.rows[0] as Record<string, unknown>;
  });
}
