import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import { wrapEmailBody } from "@/lib/email";
import { sql } from "@/lib/db";
import { sendEmail } from "@/lib/ses";
import * as targets from "@/lib/queries/targets";
import * as content from "@/lib/queries/content";
import { getEnv } from "@/lib/env";

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const body = await request.json();
  const { target_id, content_id, campaign_id } = body;
  let { subject, body: emailBody } = body;

  if (!target_id) {
    return jsonResponse({ error: "target_id is required" }, 400);
  }

  // Get target
  const target = await targets.getById(auth.tenantId, target_id);
  if (!target) {
    return jsonResponse({ detail: "Target not found" }, 404);
  }

  if (target.status !== "active") {
    return jsonResponse(
      { detail: `Cannot send to target with status: ${target.status}` },
      400
    );
  }

  // Get content or use provided subject/body
  if (content_id) {
    const contentItem = await content.getById(auth.tenantId, content_id);
    if (!contentItem) {
      return jsonResponse({ detail: "Content not found" }, 404);
    }
    subject = subject || contentItem.subject;
    emailBody = emailBody || contentItem.body;
  }

  if (!subject || !emailBody) {
    return jsonResponse(
      { detail: "Subject and body are required" },
      400
    );
  }

  // Wrap email body in standard layout
  emailBody = wrapEmailBody(emailBody);

  // Create email send record
  const sendRows = await sql`
    INSERT INTO email_sends (
      organization_id, campaign_id, target_id,
      email, subject, body, status
    ) VALUES (
      ${auth.tenantId}, ${campaign_id ?? null}::uuid, ${target_id}::uuid,
      ${target.email}, ${subject}, ${emailBody}, 'queued'
    )
    RETURNING id
  `;
  const sendId = sendRows[0].id;

  // Get org email domain settings
  const orgRows = await sql`
    SELECT email_domain, email_domain_verified, email_from_name,
           ses_tenant_name, ses_configuration_set
    FROM organizations WHERE id = ${auth.tenantId}
  `;
  const org = orgRows[0];

  // Build from_email if org has verified domain
  let fromEmail: string | undefined;
  if (org?.email_domain && org?.email_domain_verified) {
    const fromName = org.email_from_name || "noreply";
    fromEmail = `${fromName}@${org.email_domain}`;
  }

  const apiBaseUrl = getEnv().NEXT_PUBLIC_URL;

  // Send via SES
  const result = await sendEmail({
    toEmail: target.email,
    subject,
    bodyHtml: emailBody,
    fromEmail,
    configurationSet: org?.ses_configuration_set,
    tenantName: org?.ses_tenant_name,
    unsubscribeUrl: `${apiBaseUrl}/unsubscribe/${target_id}`,
  });

  // Update send record
  if (result.success) {
    await sql`
      UPDATE email_sends
      SET status = 'sent', ses_message_id = ${result.messageId as string}, sent_at = NOW()
      WHERE id = ${sendId}::uuid
    `;
    return jsonResponse({
      id: sendId,
      email: target.email,
      status: "sent",
      ses_message_id: result.messageId,
      sent_at: null,
    });
  } else {
    await sql`
      UPDATE email_sends
      SET status = 'failed'
      WHERE id = ${sendId}::uuid
    `;
    return jsonResponse(
      { detail: `Failed to send email: ${result.errorMessage}` },
      500
    );
  }
}
