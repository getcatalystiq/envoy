import { sql } from "@/lib/db";
import { getEnv } from "@/lib/env";


type Row = Record<string, any>;

/** Columns allowed in dynamic UPDATE SET clauses — prevents SQL injection via key names. */
const ALLOWED_UPDATE_COLUMNS = new Set([
  "name", "email_domain", "email_domain_verified", "email_domain_dkim_tokens",
  "email_from_name", "ses_tenant_name", "ses_configuration_set",
  "twin_agent_id", "twin_api_key",
]);

/**
 * Resolve the Twin agent ID for an organization. Returns null when the
 * organization is missing or has no agent configured.
 */
export async function getTwinAgentId(orgId: string): Promise<string | null> {
  const rows = await sql`
    SELECT twin_agent_id FROM organizations WHERE id = ${orgId}
  `;
  if (rows.length === 0 || !rows[0].twin_agent_id) return null;
  return String(rows[0].twin_agent_id);
}

/**
 * Resolve the Twin API key for an organization. Per-org `twin_api_key` wins
 * when set; otherwise falls back to the deployment-wide `TWIN_API_KEY` env var.
 * Always returns a non-empty string (env var is required), so callers can use
 * it directly without null handling.
 */
export async function resolveTwinApiKey(orgId: string): Promise<string> {
  const rows = await sql`
    SELECT twin_api_key FROM organizations WHERE id = ${orgId}
  `;
  const orgKey = rows[0]?.twin_api_key;
  if (typeof orgKey === "string" && orgKey.length > 0) return orgKey;
  return getEnv().TWIN_API_KEY;
}

export async function getOrganization(orgId: string): Promise<Row | null> {
  // Never SELECT twin_api_key itself — the route surfaces a boolean only so the
  // secret never leaves the server. resolveTwinApiKey() is the only way to read
  // the value, and it's only callable from server code (lib/twin callers).
  const rows = await sql`
    SELECT id, name, email_domain, email_domain_verified,
           email_domain_dkim_tokens, email_from_name,
           ses_tenant_name, ses_configuration_set,
           twin_agent_id,
           (twin_api_key IS NOT NULL AND length(twin_api_key) > 0) AS twin_api_key_configured
    FROM organizations
    WHERE id = ${orgId}
  `;
  return rows[0] ?? null;
}

export async function updateOrganization(
  orgId: string,
  fields: Record<string, unknown>
): Promise<Row | null> {
  if (!fields || Object.keys(fields).length === 0) {
    return getOrganization(orgId);
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_UPDATE_COLUMNS.has(key)) {
      throw new Error(`Unknown field: ${key}`);
    }
    values.push(value);
    setClauses.push(`${key} = $${values.length + 1}`);
  }

  if (setClauses.length === 0) {
    return getOrganization(orgId);
  }

  const query = `
    UPDATE organizations
    SET ${setClauses.join(", ")}, updated_at = NOW()
    WHERE id = $1
    RETURNING id, name, email_domain, email_domain_verified,
              email_domain_dkim_tokens, email_from_name,
              ses_tenant_name, ses_configuration_set,
              twin_agent_id,
              (twin_api_key IS NOT NULL AND length(twin_api_key) > 0) AS twin_api_key_configured
  `;
  const rows = await sql.query(query, [orgId, ...values]);
  return rows[0] ?? null;
}

export async function getDomainVerificationStatus(
  orgId: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT email_domain, email_domain_verified, email_domain_dkim_tokens,
           ses_tenant_name, ses_configuration_set
    FROM organizations
    WHERE id = ${orgId}
  `;
  return rows[0] ?? null;
}

export async function updateDomainVerification(
  orgId: string,
  verified: boolean,
  dkimTokens: string[],
  tenantName: string | null = null,
  configSetName: string | null = null
): Promise<void> {
  await sql`
    UPDATE organizations
    SET email_domain_verified = ${verified},
        email_domain_dkim_tokens = ${dkimTokens},
        ses_tenant_name = COALESCE(${tenantName}, ses_tenant_name),
        ses_configuration_set = COALESCE(${configSetName}, ses_configuration_set),
        updated_at = NOW()
    WHERE id = ${orgId}
  `;
}

/**
 * Format DNS records needed for SES domain verification.
 * Returns DKIM CNAMEs, MAIL FROM (MX + SPF), and DMARC records.
 */
export function formatDnsRecords(
  domain: string,
  tokens: string[],
  region: string = "us-east-1"
): Row[] {
  const records: Row[] = [];

  // DKIM CNAME records
  for (const token of tokens) {
    records.push({
      type: "CNAME",
      name: `${token}._domainkey.${domain}`,
      value: `${token}.dkim.amazonses.com`,
    });
  }

  // MAIL FROM MX record
  const mailFromSubdomain = `mail.${domain}`;
  records.push({
    type: "MX",
    name: mailFromSubdomain,
    value: `10 feedback-smtp.${region}.amazonses.com`,
  });

  // MAIL FROM SPF record
  records.push({
    type: "TXT",
    name: mailFromSubdomain,
    value: "v=spf1 include:amazonses.com ~all",
  });

  // DMARC record
  records.push({
    type: "TXT",
    name: `_dmarc.${domain}`,
    value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
  });

  return records;
}
