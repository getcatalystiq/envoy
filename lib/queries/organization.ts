import { sql } from "@/lib/db";
import { getEnv } from "@/lib/env";


type Row = Record<string, any>;

/** Columns allowed in dynamic UPDATE SET clauses — prevents SQL injection via key names. */
const ALLOWED_UPDATE_COLUMNS = new Set([
  "name", "email_domain", "email_domain_verified", "email_domain_dkim_tokens",
  "email_from_name", "ses_tenant_name", "ses_configuration_set",
  "agent_id", "environment_id", "vault_id",
]);

/** Resolved per-org Claude Managed Agents config. */
export interface AgentConfig {
  agentId: string;
  environmentId: string;
  /** Vault ids passed as session `vault_ids` so MCP servers can authenticate.
   * Empty when the org has no vault configured. */
  vaultIds: string[];
}

/**
 * Resolve an organization's Managed Agents config. `environment_id` falls back
 * to the deployment-wide `ANTHROPIC_DEFAULT_ENVIRONMENT_ID` when the org leaves
 * it blank. Returns null (→ treat as unconfigured, 503) when EITHER `agent_id`
 * OR the resolved `environment_id` is missing — `environment_id` is required by
 * `sessions.create`, so a configured-agent/no-env org must surface as
 * "not configured", never as a 502 on every call. Auth is the deployment-wide
 * `ANTHROPIC_API_KEY` (read by the SDK from env); there is no per-org key.
 */
export async function getAgentConfig(orgId: string): Promise<AgentConfig | null> {
  const rows = await sql`
    SELECT agent_id, environment_id, vault_id FROM organizations WHERE id = ${orgId}
  `;
  const row = rows[0];
  if (!row || !row.agent_id) return null;
  const orgEnv = row.environment_id;
  const environmentId =
    typeof orgEnv === "string" && orgEnv.length > 0
      ? orgEnv
      : getEnv().ANTHROPIC_DEFAULT_ENVIRONMENT_ID;
  if (!environmentId) return null;
  const orgVault = row.vault_id;
  const vaultIds =
    typeof orgVault === "string" && orgVault.length > 0 ? [orgVault] : [];
  return {
    agentId: String(row.agent_id),
    environmentId: String(environmentId),
    vaultIds,
  };
}

export async function getOrganization(orgId: string): Promise<Row | null> {
  // agent_id / environment_id are not secret (they only resolve to anything
  // with a valid ANTHROPIC_API_KEY), so unlike the old twin_api_key they are
  // selected and returned plainly.
  const rows = await sql`
    SELECT id, name, email_domain, email_domain_verified,
           email_domain_dkim_tokens, email_from_name,
           ses_tenant_name, ses_configuration_set,
           agent_id, environment_id, vault_id
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
              agent_id, environment_id, vault_id
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
