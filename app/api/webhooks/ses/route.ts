import { verifySnsMessage, handleSnsSubscriptionConfirmation } from "@/lib/sns-verify";
import { jsonResponse } from "@/lib/utils";
import { sql } from "@/lib/db";

function parseTimestamp(ts: string | undefined): string | null {
  if (!ts) return null;
  try {
    const normalized = ts.endsWith("Z") ? ts.slice(0, -1) + "+00:00" : ts;
    return new Date(normalized).toISOString();
  } catch {
    return null;
  }
}

function getEventTimestamp(event: Record<string, unknown>, eventType: string): string | null {
  const eventTypeMap: Record<string, string> = {
    Delivery: "delivery",
    Open: "open",
    Click: "click",
    Bounce: "bounce",
    Complaint: "complaint",
    Send: "send",
  };

  if (eventType in eventTypeMap) {
    const eventData = event[eventTypeMap[eventType]] as Record<string, unknown> | undefined;
    if (eventData?.timestamp) return parseTimestamp(eventData.timestamp as string);
  }

  if (event.timestamp) return parseTimestamp(event.timestamp as string);

  const mail = event.mail as Record<string, unknown> | undefined;
  return parseTimestamp(mail?.timestamp as string | undefined);
}

async function updateSendStatus(
  sesMessageId: string,
  status: string,
  extraFields: Record<string, unknown> = {},
) {
  const allowedFields = new Set([
    "delivered_at",
    "opened_at",
    "clicked_at",
    "bounced_at",
    "bounce_type",
    "complained_at",
  ]);

  const setParts = ["status = $2"];
  const params: unknown[] = [sesMessageId, status];
  let idx = 3;

  for (const [field, value] of Object.entries(extraFields)) {
    if (value != null && allowedFields.has(field)) {
      setParts.push(`${field} = $${idx}`);
      params.push(value);
      idx++;
    }
  }

  await sql.query(
    `UPDATE email_sends SET ${setParts.join(", ")} WHERE ses_message_id = $1`,
    params,
  );
}

async function recordEngagementEvent(
  sesMessageId: string,
  eventType: string,
  occurredAt: string | null,
  metadata?: Record<string, unknown>,
) {
  const rows = await sql`
    SELECT id, organization_id FROM email_sends WHERE ses_message_id = ${sesMessageId}
  `;
  if (rows.length === 0) return;

  const send = rows[0];
  await sql`
    INSERT INTO engagement_events (organization_id, send_id, event_type, occurred_at, metadata)
    VALUES (${send.organization_id}, ${send.id}, ${eventType}, ${occurredAt}, ${JSON.stringify(metadata ?? {})})
  `;
}

async function updateTargetStatus(sesMessageId: string, email: string, status: string) {
  // Scope by organization_id via the email_sends record to prevent cross-tenant updates
  const sends = await sql`
    SELECT organization_id FROM email_sends WHERE ses_message_id = ${sesMessageId} LIMIT 1
  `;
  if (sends.length === 0) return;

  await sql`
    UPDATE targets SET status = ${status}, updated_at = NOW()
    WHERE email = ${email} AND organization_id = ${sends[0].organization_id} AND status = 'active'
  `;
}

async function processSesEvent(event: Record<string, unknown>) {
  const eventType = event.eventType as string;
  const mail = (event.mail ?? {}) as Record<string, unknown>;
  const sesMessageId = mail.messageId as string;

  if (!sesMessageId) return;

  const timestamp = getEventTimestamp(event, eventType);

  if (eventType === "Delivery") {
    await updateSendStatus(sesMessageId, "delivered", { delivered_at: timestamp });
    await recordEngagementEvent(sesMessageId, "delivered", timestamp);
  } else if (eventType === "Open") {
    await updateSendStatus(sesMessageId, "opened", { opened_at: timestamp });
    await recordEngagementEvent(sesMessageId, "opened", timestamp, event.open as Record<string, unknown> | undefined);
  } else if (eventType === "Click") {
    await updateSendStatus(sesMessageId, "clicked", { clicked_at: timestamp });
    await recordEngagementEvent(sesMessageId, "clicked", timestamp, event.click as Record<string, unknown> | undefined);
  } else if (eventType === "Bounce") {
    const bounce = (event.bounce ?? {}) as Record<string, unknown>;
    const bounceType = bounce.bounceType as string;
    const recipients = (bounce.bouncedRecipients ?? []) as Record<string, unknown>[];

    for (const recipient of recipients) {
      const email = recipient.emailAddress as string;
      if (!email) continue;

      if (bounceType === "Permanent") {
        await updateSendStatus(sesMessageId, "bounced", {
          bounced_at: timestamp,
          bounce_type: "permanent",
        });
        await updateTargetStatus(sesMessageId, email, "bounced");
      } else {
        await updateSendStatus(sesMessageId, "bounced", {
          bounced_at: timestamp,
          bounce_type: "soft",
        });
        // Track soft bounces
        const result = await sql`
          UPDATE email_sends
          SET soft_bounce_count = soft_bounce_count + 1
          WHERE email = ${email} AND status NOT IN ('bounced', 'failed')
          RETURNING soft_bounce_count
        `;
        if (result.length > 0 && Number(result[0].soft_bounce_count) >= 3) {
          await updateTargetStatus(sesMessageId, email, "bounced");
        }
      }
    }

    await recordEngagementEvent(sesMessageId, "bounced", timestamp, bounce);
  } else if (eventType === "Complaint") {
    const complaint = (event.complaint ?? {}) as Record<string, unknown>;
    await updateSendStatus(sesMessageId, "complained", { complained_at: timestamp });

    const recipients = (complaint.complainedRecipients ?? []) as Record<string, unknown>[];
    for (const recipient of recipients) {
      const email = recipient.emailAddress as string;
      if (email) await updateTargetStatus(sesMessageId, email, "unsubscribed");
    }

    await recordEngagementEvent(sesMessageId, "complained", timestamp, complaint);
  }
}

/** POST /api/webhooks/ses — handle SNS notifications for SES events */
export async function POST(request: Request) {
  const body = await request.text();

  let message: Record<string, unknown>;
  try {
    message = await verifySnsMessage(body);
  } catch {
    return jsonResponse({ error: "Invalid SNS message signature" }, 403);
  }

  const messageType = message.Type as string;

  // Handle subscription confirmation
  if (messageType === "SubscriptionConfirmation") {
    try {
      await handleSnsSubscriptionConfirmation(message);
      return jsonResponse({ status: "subscribed" });
    } catch {
      return jsonResponse({ error: "Failed to confirm subscription" }, 500);
    }
  }

  // Handle notification
  if (messageType === "Notification") {
    const messageBody = message.Message as string;
    try {
      const sesEvent = JSON.parse(messageBody);
      await processSesEvent(sesEvent);
      return jsonResponse({ status: "processed" });
    } catch {
      return jsonResponse({ error: "Failed to process SES event" }, 500);
    }
  }

  return jsonResponse({ status: "ignored" });
}
