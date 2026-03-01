/**
 * Cross-tenant system queries used by cron jobs ONLY.
 * These intentionally have NO org_id filter — they process work across all tenants.
 */
import { sql, getPool } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// =========================================================================
// SEQUENCE SCHEDULER
// =========================================================================

/**
 * Get enrollments due for evaluation using FOR UPDATE SKIP LOCKED
 * to safely handle concurrent scheduler instances.
 * Uses getPool() for advisory locking support.
 */
export async function getDueEnrollments(
  limit: number = 100
): Promise<Row[]> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Select and lock rows with FOR UPDATE SKIP LOCKED
    const { rows: selectedIds } = await client.query(
      `SELECT e.id
       FROM sequence_enrollments e
       JOIN sequences s ON s.id = e.sequence_id
       WHERE e.status = 'active'
         AND e.next_evaluation_at <= NOW()
         AND s.status = 'active'
       ORDER BY e.next_evaluation_at
       LIMIT $1
       FOR UPDATE OF e SKIP LOCKED`,
      [limit]
    );

    if (selectedIds.length === 0) {
      await client.query("COMMIT");
      return [];
    }

    const ids = selectedIds.map((r: Row) => r.id);

    // Atomically push next_evaluation_at 10 min into the future
    await client.query(
      `UPDATE sequence_enrollments
       SET next_evaluation_at = NOW() + INTERVAL '10 minutes'
       WHERE id = ANY($1::uuid[])`,
      [ids]
    );

    // Fetch full enrollment data with joins
    const { rows } = await client.query(
      `SELECT e.*, s.name as sequence_name, t.email as target_email,
              t.first_name as target_first_name, t.last_name as target_last_name,
              t.company as target_company, t.custom_fields as target_custom_fields,
              t.phone_normalized as target_phone, t.metadata as target_metadata,
              t.status as target_status,
              o.agentplane_tenant_id, o.agentplane_agent_id
       FROM sequence_enrollments e
       JOIN sequences s ON s.id = e.sequence_id
       JOIN targets t ON t.id = e.target_id
       JOIN organizations o ON o.id = e.organization_id
       WHERE e.id = ANY($1::uuid[])`,
      [ids]
    );

    await client.query("COMMIT");
    return rows;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// =========================================================================
// EMAIL SCHEDULER / MESSAGE SENDER
// =========================================================================

/**
 * Atomically claim queued emails by setting status='sending' and
 * processing_started_at=NOW(). Returns the claimed rows with org settings.
 * Uses CTE to claim + fetch in one round-trip, preventing double-processing.
 */
export async function claimQueuedEmails(
  limit: number = 100
): Promise<Row[]> {
  const rows = await sql`
    WITH claimable AS (
      SELECT id
      FROM email_sends
      WHERE status = 'queued'
        AND (scheduled_at IS NULL OR scheduled_at <= NOW())
      ORDER BY created_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ),
    claimed AS (
      UPDATE email_sends
      SET status = 'sending', processing_started_at = NOW()
      WHERE id IN (SELECT id FROM claimable)
      RETURNING *
    )
    SELECT c.*, o.email_domain, o.email_domain_verified, o.email_from_name,
           o.ses_tenant_name, o.ses_configuration_set
    FROM claimed c
    JOIN organizations o ON o.id = c.organization_id
  `;
  return rows;
}

/**
 * Mark an email send as sent with SES message ID.
 */
export async function markEmailSent(
  emailSendId: string,
  sesMessageId: string
): Promise<void> {
  await sql`
    UPDATE email_sends
    SET status = 'sent', ses_message_id = ${sesMessageId}, sent_at = NOW()
    WHERE id = ${emailSendId}::uuid
  `;
}

/**
 * Mark an email send as failed.
 */
export async function markEmailFailed(emailSendId: string): Promise<void> {
  await sql`
    UPDATE email_sends SET status = 'failed' WHERE id = ${emailSendId}::uuid
  `;
}

// =========================================================================
// CAMPAIGN EXECUTOR
// =========================================================================

/**
 * Atomically claim scheduled campaigns by setting processing_started_at.
 * Returns campaigns that were successfully claimed.
 * Uses FOR UPDATE SKIP LOCKED to prevent double-processing.
 */
export async function claimScheduledCampaigns(
  limit: number = 10
): Promise<Row[]> {
  const rows = await sql`
    WITH claimable AS (
      SELECT c.id
      FROM campaigns c
      JOIN organizations o ON o.id = c.organization_id
      WHERE c.status = 'scheduled'
        AND c.scheduled_at <= NOW()
        AND o.agentplane_agent_id IS NOT NULL
        AND (c.processing_started_at IS NULL
             OR c.processing_started_at < NOW() - INTERVAL '15 minutes')
      ORDER BY c.scheduled_at ASC
      LIMIT ${limit}
      FOR UPDATE OF c SKIP LOCKED
    ),
    claimed AS (
      UPDATE campaigns
      SET status = 'active', started_at = NOW(),
          processing_started_at = NOW(), updated_at = NOW()
      WHERE id IN (SELECT id FROM claimable)
      RETURNING *
    )
    SELECT cl.*, o.agentplane_tenant_id, o.agentplane_agent_id
    FROM claimed cl
    JOIN organizations o ON o.id = cl.organization_id
  `;
  return rows;
}

// =========================================================================
// WEBHOOK / SES EVENT PROCESSING
// =========================================================================

/**
 * Update email send status by SES message ID.
 * Used by webhook handler to process delivery/bounce/complaint/open/click events.
 */
export async function updateSendStatus(
  sesMessageId: string,
  status: string,
  extraFields: Record<string, unknown> = {}
): Promise<void> {
  const allowedFields = new Set([
    "delivered_at",
    "opened_at",
    "clicked_at",
    "bounced_at",
    "bounce_type",
    "complained_at",
  ]);

  const setClauses = ["status = $2"];
  const params: unknown[] = [sesMessageId, status];
  let paramIdx = 3;

  for (const [field, value] of Object.entries(extraFields)) {
    if (value != null && allowedFields.has(field)) {
      setClauses.push(`${field} = $${paramIdx}`);
      params.push(value);
      paramIdx++;
    }
  }

  const query = `
    UPDATE email_sends
    SET ${setClauses.join(", ")}
    WHERE ses_message_id = $1
  `;
  await sql.query(query, params);
}

/**
 * Update target status by email address (for bounces/complaints).
 * Cross-tenant: updates all matching targets regardless of org.
 */
export async function updateTargetStatusByEmail(
  email: string,
  status: string
): Promise<void> {
  await sql`
    UPDATE targets
    SET status = ${status}, updated_at = NOW()
    WHERE email = ${email} AND status = 'active'
  `;
}

/**
 * Record an engagement event for analytics tracking.
 */
export async function recordEngagementEvent(
  sesMessageId: string,
  eventType: string,
  occurredAt: string | Date,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const rows = await sql`
    SELECT id, organization_id FROM email_sends WHERE ses_message_id = ${sesMessageId}
  `;
  if (rows.length === 0) return;

  const send = rows[0];
  await sql`
    INSERT INTO engagement_events (organization_id, send_id, event_type, occurred_at, metadata)
    VALUES (${send.organization_id}, ${send.id}, ${eventType}, ${occurredAt}::timestamptz, ${JSON.stringify(metadata)}::jsonb)
  `;
}

/**
 * Increment soft bounce count for an email and return new count.
 */
export async function incrementSoftBounce(email: string): Promise<number> {
  const rows = await sql`
    UPDATE email_sends
    SET soft_bounce_count = soft_bounce_count + 1
    WHERE email = ${email} AND status NOT IN ('bounced', 'failed')
    RETURNING soft_bounce_count
  `;
  return rows[0]?.soft_bounce_count ?? 0;
}

/**
 * Find emails stuck in "sending" status (processing_started_at older than 10 minutes).
 * Resets them back to "queued" so they can be retried.
 */
export async function unstickSendingEmails(): Promise<number> {
  const rows = await sql`
    UPDATE email_sends
    SET status = 'queued'
    WHERE status = 'sending'
      AND processing_started_at < NOW() - INTERVAL '10 minutes'
    RETURNING id
  `;
  return rows.length;
}
