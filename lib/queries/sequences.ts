import { sql } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** Columns allowed in dynamic UPDATE SET clauses — prevents SQL injection via key names. */
const ALLOWED_SEQUENCE_UPDATE_COLUMNS = new Set([
  "name", "target_type_id", "status", "is_default",
]);

const ALLOWED_STEP_UPDATE_COLUMNS = new Set([
  "position", "default_delay_hours", "subject", "builder_content",
  "has_unpublished_changes", "approval_required",
]);

// =========================================================================
// AUTO-ENROLLMENT
// =========================================================================

/**
 * Enroll a target in all default sequences matching its target type.
 * Idempotent — skips sequences the target is already enrolled in.
 */
export async function autoEnrollInDefaultSequences(
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
        INSERT INTO sequence_enrollments (sequence_id, target_id, organization_id, status, current_step_position, next_evaluation_at)
        VALUES (${seq.id}, ${targetId}, ${orgId}, 'active', 1, NOW())
      `;
    }
  }
}

// =========================================================================
// SEQUENCES
// =========================================================================

export async function create(
  orgId: string,
  name: string,
  opts: { targetTypeId?: string; status?: string } = {}
): Promise<Row> {
  const { targetTypeId = null, status = "draft" } = opts;
  const rows = await sql`
    INSERT INTO sequences (organization_id, name, target_type_id, status)
    VALUES (${orgId}, ${name}, ${targetTypeId}::uuid, ${status})
    RETURNING *
  `;
  return rows[0];
}

export async function getById(
  orgId: string,
  sequenceId: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT s.*,
      COALESCE(
        json_agg(
          json_build_object(
            'id', ss.id,
            'position', ss.position,
            'default_delay_hours', ss.default_delay_hours,
            'subject', ss.subject,
            'builder_content', ss.builder_content,
            'has_unpublished_changes', ss.has_unpublished_changes,
            'approval_required', ss.approval_required
          )
          ORDER BY ss.position
        ) FILTER (WHERE ss.id IS NOT NULL),
        '[]'
      ) as steps
    FROM sequences s
    LEFT JOIN sequence_steps ss ON ss.sequence_id = s.id
    WHERE s.id = ${sequenceId}::uuid AND s.organization_id = ${orgId}
    GROUP BY s.id
  `;
  return rows[0] ?? null;
}

export async function getAll(
  orgId: string,
  opts: {
    status?: string;
    targetTypeId?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<Row[]> {
  const { status = null, targetTypeId = null, limit = 100, offset = 0 } = opts;
  const rows = await sql`
    SELECT
      s.*,
      COALESCE(step_stats.step_count, 0) as step_count,
      COALESCE(step_stats.total_duration_days, 0) as total_duration_days,
      COALESCE(enrollment_stats.total_enrollments, 0) as total_enrollments,
      COALESCE(enrollment_stats.active_enrollments, 0) as active_enrollments,
      COALESCE(enrollment_stats.exited_enrollments, 0) as exited_enrollments,
      COALESCE(enrollment_stats.unsubscribed_count, 0) as unsubscribed_count,
      CASE
        WHEN COALESCE(email_stats.sent_count, 0) > 0
        THEN ROUND(COALESCE(email_stats.opened_count, 0)::numeric / email_stats.sent_count * 100, 2)
        ELSE 0
      END as open_rate,
      CASE
        WHEN COALESCE(email_stats.sent_count, 0) > 0
        THEN ROUND(COALESCE(email_stats.clicked_count, 0)::numeric / email_stats.sent_count * 100, 2)
        ELSE 0
      END as click_rate
    FROM sequences s
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) as step_count,
        COALESCE(SUM(default_delay_hours) / 24, 0) as total_duration_days
      FROM sequence_steps
      WHERE sequence_id = s.id
    ) step_stats ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) as total_enrollments,
        COUNT(*) FILTER (WHERE status = 'active') as active_enrollments,
        COUNT(*) FILTER (WHERE status = 'exited') as exited_enrollments,
        COUNT(*) FILTER (WHERE status = 'exited' AND exit_reason = 'unsubscribed') as unsubscribed_count
      FROM sequence_enrollments
      WHERE sequence_id = s.id
    ) enrollment_stats ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) as sent_count,
        COUNT(*) FILTER (WHERE es.opened_at IS NOT NULL) as opened_count,
        COUNT(*) FILTER (WHERE es.clicked_at IS NOT NULL) as clicked_count
      FROM sequence_step_executions sse
      LEFT JOIN email_sends es ON es.outbox_id = sse.outbox_id
      WHERE sse.enrollment_id IN (
        SELECT id FROM sequence_enrollments WHERE sequence_id = s.id
      )
      AND es.id IS NOT NULL
    ) email_stats ON true
    WHERE s.organization_id = ${orgId}
      AND (${status}::text IS NULL OR s.status = ${status})
      AND (${targetTypeId}::uuid IS NULL OR s.target_type_id = ${targetTypeId}::uuid)
    ORDER BY s.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows;
}

export async function update(
  orgId: string,
  sequenceId: string,
  fields: Record<string, unknown>
): Promise<Row | null> {
  if (!fields || Object.keys(fields).length === 0) {
    return getById(orgId, sequenceId);
  }

  // Build SET clause dynamically (only allow known columns)
  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (ALLOWED_SEQUENCE_UPDATE_COLUMNS.has(key)) {
      values.push(value);
      setClauses.push(`${key} = $${values.length + 2}`);
    }
  }

  if (setClauses.length === 0) {
    return getById(orgId, sequenceId);
  }

  const query = `
    UPDATE sequences
    SET ${setClauses.join(", ")}
    WHERE id = $1::uuid AND organization_id = $2
    RETURNING *
  `;
  const rows = await sql.query(query, [sequenceId, orgId, ...values]);
  return rows[0] ?? null;
}

export async function remove(
  orgId: string,
  sequenceId: string
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM sequences
    WHERE id = ${sequenceId}::uuid AND organization_id = ${orgId}
    RETURNING id
  `;
  return rows.length > 0;
}

// =========================================================================
// SEQUENCE STEPS
// =========================================================================

export async function createStep(
  orgId: string,
  sequenceId: string,
  position: number,
  defaultDelayHours: number = 24
): Promise<Row> {
  const rows = await sql`
    INSERT INTO sequence_steps (sequence_id, organization_id, position, default_delay_hours)
    VALUES (${sequenceId}::uuid, ${orgId}, ${position}, ${defaultDelayHours})
    RETURNING *
  `;
  return rows[0];
}

export async function getStepById(
  orgId: string,
  stepId: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT * FROM sequence_steps
    WHERE id = ${stepId}::uuid AND organization_id = ${orgId}
  `;
  return rows[0] ?? null;
}

export async function getStepByPosition(
  orgId: string,
  sequenceId: string,
  position: number
): Promise<Row | null> {
  const rows = await sql`
    SELECT ss.* FROM sequence_steps ss
    JOIN sequences s ON s.id = ss.sequence_id
    WHERE ss.sequence_id = ${sequenceId}::uuid
      AND ss.position = ${position}
      AND s.organization_id = ${orgId}
  `;
  return rows[0] ?? null;
}

export async function getSteps(
  orgId: string,
  sequenceId: string
): Promise<Row[]> {
  const rows = await sql`
    SELECT ss.* FROM sequence_steps ss
    JOIN sequences s ON s.id = ss.sequence_id
    WHERE ss.sequence_id = ${sequenceId}::uuid
      AND s.organization_id = ${orgId}
    ORDER BY ss.position
  `;
  return rows;
}

export async function updateStep(
  orgId: string,
  stepId: string,
  fields: Record<string, unknown>
): Promise<Row | null> {
  if (!fields || Object.keys(fields).length === 0) {
    return getStepById(orgId, stepId);
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && ALLOWED_STEP_UPDATE_COLUMNS.has(key)) {
      values.push(value);
      setClauses.push(`${key} = $${values.length + 2}`);
    }
  }

  if (setClauses.length === 0) {
    return getStepById(orgId, stepId);
  }

  const query = `
    UPDATE sequence_steps
    SET ${setClauses.join(", ")}
    WHERE id = $1::uuid AND organization_id = $2
    RETURNING *
  `;
  const rows = await sql.query(query, [stepId, orgId, ...values]);
  return rows[0] ?? null;
}

export async function deleteStep(
  orgId: string,
  stepId: string
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM sequence_steps
    WHERE id = ${stepId}::uuid AND organization_id = ${orgId}
    RETURNING id
  `;
  return rows.length > 0;
}

export async function getStepContent(
  orgId: string,
  stepId: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT id, subject, builder_content, approval_required
    FROM sequence_steps
    WHERE id = ${stepId}::uuid AND organization_id = ${orgId}
  `;
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    content_id: null,
    content_subject: row.subject || "",
    content_body: "",
    builder_content: row.builder_content,
    approval_required: row.approval_required,
  };
}

// =========================================================================
// ENROLLMENTS
// =========================================================================

export async function getFirstStepDelay(
  orgId: string,
  sequenceId: string
): Promise<number> {
  const rows = await sql`
    SELECT ss.default_delay_hours
    FROM sequence_steps ss
    JOIN sequences s ON s.id = ss.sequence_id
    WHERE ss.sequence_id = ${sequenceId}::uuid
      AND ss.position = 1
      AND s.organization_id = ${orgId}
  `;
  return rows[0]?.default_delay_hours ?? 0;
}

export async function enroll(
  orgId: string,
  targetId: string,
  sequenceId: string,
  firstStepDelayHours?: number
): Promise<Row> {
  // If no explicit delay, use the first step's configured delay
  if (firstStepDelayHours === undefined) {
    firstStepDelayHours = await getFirstStepDelay(orgId, sequenceId);
  }

  const rows = await sql`
    INSERT INTO sequence_enrollments (
      organization_id, target_id, sequence_id,
      current_step_position, status, next_evaluation_at
    )
    VALUES (
      ${orgId}, ${targetId}::uuid, ${sequenceId}::uuid,
      1, 'active', NOW() + make_interval(hours => ${firstStepDelayHours})
    )
    RETURNING *
  `;
  return rows[0];
}

export async function getEnrollmentById(
  orgId: string,
  enrollmentId: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT e.*, s.name as sequence_name, t.email as target_email
    FROM sequence_enrollments e
    JOIN sequences s ON s.id = e.sequence_id
    JOIN targets t ON t.id = e.target_id
    WHERE e.id = ${enrollmentId}::uuid AND e.organization_id = ${orgId}
  `;
  return rows[0] ?? null;
}

export async function getActiveEnrollment(
  orgId: string,
  targetId: string,
  sequenceId: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT * FROM sequence_enrollments
    WHERE target_id = ${targetId}::uuid
      AND sequence_id = ${sequenceId}::uuid
      AND organization_id = ${orgId}
      AND status IN ('active', 'paused')
  `;
  return rows[0] ?? null;
}

export async function getEnrollments(
  orgId: string,
  opts: {
    sequenceId?: string;
    targetId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<Row[]> {
  const {
    sequenceId = null,
    targetId = null,
    status = null,
    limit = 100,
    offset = 0,
  } = opts;

  const rows = await sql`
    SELECT e.*, s.name as sequence_name, t.email as target_email
    FROM sequence_enrollments e
    JOIN sequences s ON s.id = e.sequence_id
    JOIN targets t ON t.id = e.target_id
    WHERE e.organization_id = ${orgId}
      AND (${sequenceId}::uuid IS NULL OR e.sequence_id = ${sequenceId}::uuid)
      AND (${targetId}::uuid IS NULL OR e.target_id = ${targetId}::uuid)
      AND (${status}::text IS NULL OR e.status = ${status})
    ORDER BY e.enrolled_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows;
}

export async function pauseEnrollment(
  orgId: string,
  enrollmentId: string
): Promise<Row | null> {
  const rows = await sql`
    UPDATE sequence_enrollments
    SET status = 'paused', paused_at = NOW()
    WHERE id = ${enrollmentId}::uuid
      AND organization_id = ${orgId}
      AND status = 'active'
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function resumeEnrollment(
  orgId: string,
  enrollmentId: string
): Promise<Row | null> {
  const rows = await sql`
    UPDATE sequence_enrollments
    SET status = 'active',
        next_evaluation_at = next_evaluation_at + (NOW() - paused_at),
        paused_at = NULL
    WHERE id = ${enrollmentId}::uuid
      AND organization_id = ${orgId}
      AND status = 'paused'
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function pauseAllEnrollments(
  orgId: string,
  sequenceId: string
): Promise<number> {
  const rows = await sql`
    UPDATE sequence_enrollments
    SET status = 'paused', paused_at = NOW()
    WHERE sequence_id = ${sequenceId}::uuid
      AND organization_id = ${orgId}
      AND status = 'active'
    RETURNING id
  `;
  return rows.length;
}

export async function resumeAllEnrollments(
  orgId: string,
  sequenceId: string
): Promise<number> {
  const rows = await sql`
    UPDATE sequence_enrollments
    SET status = 'active',
        next_evaluation_at = next_evaluation_at + (NOW() - paused_at),
        paused_at = NULL
    WHERE sequence_id = ${sequenceId}::uuid
      AND organization_id = ${orgId}
      AND status = 'paused'
    RETURNING id
  `;
  return rows.length;
}

export async function completeEnrollment(
  orgId: string,
  enrollmentId: string,
  status: string = "completed",
  exitReason: string | null = null
): Promise<Row | null> {
  const rows = await sql`
    UPDATE sequence_enrollments
    SET status = ${status}, exit_reason = ${exitReason}
    WHERE id = ${enrollmentId}::uuid
      AND organization_id = ${orgId}
      AND status IN ('active', 'paused')
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function advanceEnrollment(
  orgId: string,
  enrollmentId: string,
  nextStepDelayHours: number
): Promise<Row | null> {
  const rows = await sql`
    UPDATE sequence_enrollments
    SET current_step_position = current_step_position + 1,
        last_step_completed_at = NOW(),
        next_evaluation_at = NOW() + make_interval(hours => ${nextStepDelayHours})
    WHERE id = ${enrollmentId}::uuid
      AND organization_id = ${orgId}
      AND status = 'active'
    RETURNING *
  `;
  return rows[0] ?? null;
}

// =========================================================================
// STEP EXECUTIONS
// =========================================================================

export async function recordExecution(
  orgId: string,
  enrollmentId: string,
  stepPosition: number,
  opts: {
    contentId?: string;
    emailSendId?: string;
    outboxId?: string;
    status?: string;
  } = {}
): Promise<Row> {
  const {
    contentId = null,
    emailSendId = null,
    outboxId = null,
    status = "executed",
  } = opts;
  const rows = await sql`
    INSERT INTO sequence_step_executions (
      organization_id, enrollment_id, step_position,
      content_id, email_send_id, outbox_id, status
    )
    VALUES (
      ${orgId}, ${enrollmentId}::uuid, ${stepPosition},
      ${contentId}::uuid, ${emailSendId}::uuid, ${outboxId}::uuid, ${status}
    )
    RETURNING *
  `;
  return rows[0];
}

export async function getStepExecutions(
  orgId: string,
  enrollmentId: string
): Promise<Row[]> {
  const rows = await sql`
    SELECT sse.*, c.name as content_name
    FROM sequence_step_executions sse
    LEFT JOIN content c ON c.id = sse.content_id
    WHERE sse.enrollment_id = ${enrollmentId}::uuid
      AND sse.organization_id = ${orgId}
    ORDER BY sse.step_position
  `;
  return rows;
}

// =========================================================================
// DEFAULT SEQUENCE METHODS
// =========================================================================

export async function getDefaultForTargetType(
  orgId: string,
  targetTypeId: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT * FROM sequences
    WHERE organization_id = ${orgId}
      AND target_type_id = ${targetTypeId}::uuid
      AND is_default = TRUE
      AND status = 'active'
  `;
  return rows[0] ?? null;
}

export async function unsetDefaultForTargetType(
  orgId: string,
  targetTypeId: string
): Promise<void> {
  await sql`
    UPDATE sequences
    SET is_default = FALSE
    WHERE organization_id = ${orgId}
      AND target_type_id = ${targetTypeId}::uuid
      AND is_default = TRUE
  `;
}
