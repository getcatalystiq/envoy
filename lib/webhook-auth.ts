import crypto from "node:crypto";
import { sql } from "@/lib/db";
import { jsonResponse } from "@/lib/utils";

export async function verifyWebhookSecret(
  orgId: string,
  providedSecret: string
): Promise<Response | null> {
  if (!providedSecret) {
    return jsonResponse({ error: "Missing X-Webhook-Secret header" }, 401);
  }

  const rows = await sql`
    SELECT webhook_secret FROM organizations WHERE id = ${orgId}
  `;

  if (rows.length === 0) {
    return jsonResponse({ error: "Organization not found" }, 404);
  }

  const expectedSecret: string | null = rows[0].webhook_secret;

  if (!expectedSecret) {
    return jsonResponse(
      {
        error:
          "Webhook not configured for this organization. Set webhook_secret first.",
      },
      401
    );
  }

  const a = Buffer.from(providedSecret);
  const b = Buffer.from(expectedSecret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return jsonResponse({ error: "Invalid webhook secret" }, 401);
  }

  return null; // Auth passed
}

export async function getOrganizationWebhookSecret(
  orgId: string
): Promise<string | null> {
  const rows = await sql`
    SELECT webhook_secret FROM organizations WHERE id = ${orgId}
  `;

  if (rows.length === 0) {
    return null;
  }

  return rows[0].webhook_secret;
}

export async function setOrganizationWebhookSecret(
  orgId: string,
  secret: string
): Promise<void> {
  await sql`
    UPDATE organizations
    SET webhook_secret = ${secret}
    WHERE id = ${orgId}
  `;
}

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}
