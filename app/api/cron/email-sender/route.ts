import { verifyCronSecret } from "@/lib/cron-utils";
import { wrapEmailBody } from "@/lib/email";
import * as outboxQueries from "@/lib/queries/outbox";
import {
  claimQueuedEmails,
  markEmailSent,
  markEmailFailed,
  unstickSendingEmails,
} from "@/lib/queries/system";
import { sendEmail } from "@/lib/ses";
import { jsonResponse } from "@/lib/utils";

export const maxDuration = 800;

const MAX_CONCURRENT = 10;

async function sendOneEmail(
  send: Record<string, unknown>
): Promise<{ status: "sent" | "failed"; id: string }> {
  const sendId = String(send.id);

  // Build from_email if org has verified domain
  let fromEmail: string | undefined;
  if (send.email_domain && send.email_domain_verified) {
    const fromName = (send.email_from_name as string) || "noreply";
    fromEmail = `${fromName}@${send.email_domain}`;
  }

  const baseUrl = process.env.NEXT_PUBLIC_URL || "https://app.envoy.app";
  const unsubscribeUrl = `${baseUrl}/api/unsubscribe/${send.target_id}`;

  const bodyHtml = wrapEmailBody((send.body as string) || "");

  const result = await sendEmail({
    toEmail: send.email as string,
    subject: (send.subject as string) || "",
    bodyHtml,
    fromEmail,
    configurationSet: (send.ses_configuration_set as string) || undefined,
    tenantName: (send.ses_tenant_name as string) || undefined,
    unsubscribeUrl,
  });

  if (result.success) {
    const messageId = result.messageId as string;
    await markEmailSent(sendId, messageId);

    if (send.outbox_id) {
      await outboxQueries.markSent(
        String(send.organization_id),
        String(send.outbox_id),
        { message_id: messageId }
      );
    }
    console.log(
      `Sent email ${sendId} to ${send.email} (ses_id=${messageId})`
    );
    return { status: "sent", id: sendId };
  } else {
    const errorMsg = `${result.errorCode}: ${result.errorMessage}`;
    console.error(
      `Email send failed: ${sendId} to ${send.email} - ${errorMsg}`
    );
    await markEmailFailed(sendId);

    if (send.outbox_id) {
      await outboxQueries.markFailed(
        String(send.organization_id),
        String(send.outbox_id),
        errorMsg
      );
    }
    return { status: "failed", id: sendId };
  }
}

export async function GET(request: Request) {
  const authError = verifyCronSecret(request);
  if (authError) return authError;

  // Unstick emails stuck in "sending" for >10 minutes
  const unstuck = await unstickSendingEmails();
  if (unstuck > 0) {
    console.log(`Unstuck ${unstuck} email(s) stuck in sending state`);
  }

  // Atomically claim queued emails (sets status='sending')
  const sends = await claimQueuedEmails(100);

  if (sends.length === 0) {
    return jsonResponse({ sent: 0, failed: 0, unstuck });
  }

  console.log(`Claimed ${sends.length} email(s) for sending`);

  // Send with bounded concurrency using Promise.allSettled
  let sentCount = 0;
  let failedCount = 0;

  for (let i = 0; i < sends.length; i += MAX_CONCURRENT) {
    const batch = sends.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.allSettled(
      batch.map((send) => sendOneEmail(send))
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value.status === "sent") sentCount++;
        else failedCount++;
      } else {
        failedCount++;
        console.error("Unexpected email send error:", result.reason);
      }
    }
  }

  return jsonResponse({ sent: sentCount, failed: failedCount, unstuck });
}
