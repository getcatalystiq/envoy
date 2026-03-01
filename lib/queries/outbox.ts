import { sql } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** Columns allowed in dynamic UPDATE SET clauses — prevents SQL injection via key names. */
const ALLOWED_UPDATE_COLUMNS = new Set([
  "subject", "body", "channel", "priority", "scheduled_for",
  "status", "confidence_score", "snooze_until", "rejection_reason",
  "reviewed_by", "reviewed_at", "send_result",
]);

export async function create(
  orgId: string,
  targetId: string,
  channel: string,
  body: string,
  opts: {
    subject?: string;
    confidenceScore?: number;
    priority?: number;
    scheduledFor?: string;
    createdBy?: string;
    status?: string;
  } = {}
): Promise<Row> {
  const {
    subject = null,
    confidenceScore = null,
    priority = 5,
    scheduledFor = null,
    createdBy = null,
    status = "pending",
  } = opts;
  const rows = await sql`
    INSERT INTO outbox (
      organization_id, target_id, channel, subject, body,
      confidence_score, priority, scheduled_for, created_by,
      status, reviewed_at
    ) VALUES (
      ${orgId}, ${targetId}::uuid, ${channel}, ${subject}, ${body},
      ${confidenceScore}, ${priority}, ${scheduledFor}::timestamptz, ${createdBy}::uuid,
      ${status}, CASE WHEN ${status} = 'approved' THEN NOW() ELSE NULL END
    )
    RETURNING *
  `;
  return rows[0];
}

export async function getById(
  orgId: string,
  outboxId: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT * FROM outbox
    WHERE id = ${outboxId}::uuid AND organization_id = ${orgId}
  `;
  return rows[0] ?? null;
}

export async function getAll(
  orgId: string,
  opts: {
    status?: string;
    channel?: string;
    targetId?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<Row[]> {
  const {
    status = null,
    channel = null,
    targetId = null,
    limit = 100,
    offset = 0,
  } = opts;
  const rows = await sql`
    SELECT o.*, t.email, t.first_name, t.last_name, t.company, t.metadata,
           es.delivered_at, es.opened_at, es.clicked_at,
           es.bounced_at, es.complained_at
    FROM outbox o
    LEFT JOIN targets t ON o.target_id = t.id
    LEFT JOIN LATERAL (
      SELECT delivered_at, opened_at, clicked_at, bounced_at, complained_at
      FROM email_sends
      WHERE outbox_id = o.id
      ORDER BY created_at DESC
      LIMIT 1
    ) es ON true
    WHERE o.organization_id = ${orgId}
      AND (${status}::text IS NULL OR o.status = ${status})
      AND (${channel}::text IS NULL OR o.channel = ${channel})
      AND (${targetId}::uuid IS NULL OR o.target_id = ${targetId}::uuid)
    ORDER BY o.priority DESC, o.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows;
}

export async function listPending(
  orgId: string,
  limit: number = 100,
  offset: number = 0
): Promise<Row[]> {
  const rows = await sql`
    SELECT o.*, t.email, t.first_name, t.last_name, t.company, t.metadata
    FROM outbox o
    LEFT JOIN targets t ON o.target_id = t.id
    WHERE o.organization_id = ${orgId} AND o.status = 'pending'
    ORDER BY o.priority DESC, o.created_at ASC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows;
}

export async function count(
  orgId: string,
  status?: string
): Promise<number> {
  if (status) {
    const rows = await sql`
      SELECT COUNT(*)::int as count FROM outbox
      WHERE organization_id = ${orgId} AND status = ${status}
    `;
    return rows[0]?.count ?? 0;
  }
  const rows = await sql`
    SELECT COUNT(*)::int as count FROM outbox
    WHERE organization_id = ${orgId}
  `;
  return rows[0]?.count ?? 0;
}

export async function update(
  orgId: string,
  outboxId: string,
  fields: Record<string, unknown>
): Promise<Row | null> {
  if (!fields || Object.keys(fields).length === 0) {
    return getById(orgId, outboxId);
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && ALLOWED_UPDATE_COLUMNS.has(key)) {
      values.push(value);
      setClauses.push(`${key} = $${values.length + 2}`);
    }
  }

  if (setClauses.length === 0) {
    return getById(orgId, outboxId);
  }

  const query = `
    UPDATE outbox
    SET ${setClauses.join(", ")}
    WHERE id = $1::uuid AND organization_id = $2
    RETURNING *
  `;
  const rows = await sql.query(query, [outboxId, orgId, ...values]);
  return rows[0] ?? null;
}

export async function approve(
  orgId: string,
  outboxId: string,
  reviewedBy: string | null = null
): Promise<Row | null> {
  const rows = await sql`
    UPDATE outbox
    SET status = 'approved', reviewed_by = ${reviewedBy}::uuid, reviewed_at = NOW()
    WHERE id = ${outboxId}::uuid
      AND organization_id = ${orgId}
      AND status = 'pending'
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function reject(
  orgId: string,
  outboxId: string,
  rejectionReason: string | null = null,
  reviewedBy: string | null = null
): Promise<Row | null> {
  const rows = await sql`
    UPDATE outbox
    SET status = 'rejected', rejection_reason = ${rejectionReason},
        reviewed_by = ${reviewedBy}::uuid, reviewed_at = NOW()
    WHERE id = ${outboxId}::uuid
      AND organization_id = ${orgId}
      AND status = 'pending'
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function snooze(
  orgId: string,
  outboxId: string,
  snoozeUntil: string,
  reviewedBy: string | null = null
): Promise<Row | null> {
  const rows = await sql`
    UPDATE outbox
    SET status = 'snoozed', snooze_until = ${snoozeUntil}::timestamptz,
        reviewed_by = ${reviewedBy}::uuid, reviewed_at = NOW()
    WHERE id = ${outboxId}::uuid
      AND organization_id = ${orgId}
      AND status = 'pending'
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function unsnoozeDue(orgId: string): Promise<number> {
  const rows = await sql`
    UPDATE outbox
    SET status = 'pending', snooze_until = NULL
    WHERE organization_id = ${orgId}
      AND status = 'snoozed'
      AND snooze_until <= NOW()
    RETURNING id
  `;
  return rows.length;
}

export async function markSent(
  orgId: string,
  outboxId: string,
  sendResult: Record<string, unknown>
): Promise<Row | null> {
  const rows = await sql`
    UPDATE outbox
    SET status = 'sent', send_result = ${JSON.stringify(sendResult)}::jsonb
    WHERE id = ${outboxId}::uuid
      AND organization_id = ${orgId}
      AND status = 'approved'
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function markFailed(
  orgId: string,
  outboxId: string,
  error: string
): Promise<Row | null> {
  const rows = await sql`
    UPDATE outbox
    SET status = 'failed', send_result = ${JSON.stringify({ error })}::jsonb
    WHERE id = ${outboxId}::uuid
      AND organization_id = ${orgId}
      AND status = 'approved'
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function retry(
  orgId: string,
  outboxId: string
): Promise<Row | null> {
  const rows = await sql`
    UPDATE outbox
    SET status = 'approved', send_result = NULL
    WHERE id = ${outboxId}::uuid
      AND organization_id = ${orgId}
      AND status = 'failed'
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function addEdit(
  orgId: string,
  outboxId: string,
  userId: string,
  field: string,
  oldValue: string,
  newValue: string
): Promise<Row | null> {
  const editEntry = {
    timestamp: new Date().toISOString(),
    user_id: userId,
    field,
    old_value: oldValue,
    new_value: newValue,
  };
  const rows = await sql`
    UPDATE outbox
    SET edit_history = edit_history || ${JSON.stringify([editEntry])}::jsonb
    WHERE id = ${outboxId}::uuid AND organization_id = ${orgId}
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function remove(
  orgId: string,
  outboxId: string
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM outbox
    WHERE id = ${outboxId}::uuid AND organization_id = ${orgId}
    RETURNING id
  `;
  return rows.length > 0;
}

export async function getStats(orgId: string): Promise<Record<string, number>> {
  const rows = await sql`
    SELECT status, COUNT(*)::int as count
    FROM outbox
    WHERE organization_id = ${orgId}
    GROUP BY status
  `;
  const stats: Record<string, number> = {};
  for (const row of rows) {
    stats[row.status] = row.count;
  }
  return stats;
}
