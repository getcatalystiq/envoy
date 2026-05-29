import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as org from "@/lib/queries/organization";
import { verifyDomain } from "@/lib/ses";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const row = await org.getOrganization(auth.tenantId);
  if (!row) {
    return jsonResponse({ error: "Organization not found" }, 404);
  }

  let dnsRecords: unknown[] = [];
  if (row.email_domain && row.email_domain_dkim_tokens) {
    dnsRecords = org.formatDnsRecords(row.email_domain, row.email_domain_dkim_tokens);
  }

  return jsonResponse({
    ...row,
    email_domain_verified: row.email_domain_verified ?? false,
    dns_records: dnsRecords,
  });
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const body = await request.json();
  const { email_from_name, email_domain, twin_agent_id, twin_api_key } = body;

  const updates: Record<string, unknown> = {};

  if (email_from_name !== undefined) {
    updates.email_from_name = email_from_name;
  }

  if (twin_api_key !== undefined) {
    // null or empty string unconfigures (falls back to env var).
    if (twin_api_key === null || twin_api_key === "") {
      updates.twin_api_key = null;
    } else if (
      typeof twin_api_key === "string" &&
      twin_api_key.trim().length > 0
    ) {
      updates.twin_api_key = twin_api_key.trim();
    } else {
      return jsonResponse(
        { error: "twin_api_key must be a non-empty string or null" },
        400,
      );
    }
  }

  if (twin_agent_id !== undefined) {
    // Accept null / empty string to unconfigure; otherwise require a non-empty
    // trimmed string.
    if (twin_agent_id === null || twin_agent_id === "") {
      updates.twin_agent_id = null;
    } else if (typeof twin_agent_id === "string" && twin_agent_id.trim().length > 0) {
      updates.twin_agent_id = twin_agent_id.trim();
    } else {
      return jsonResponse(
        { error: "twin_agent_id must be a non-empty string or null" },
        400,
      );
    }
  }

  if (email_domain !== undefined) {
    if (email_domain) {
      const result = await verifyDomain(email_domain);
      updates.email_domain = email_domain;
      updates.email_domain_dkim_tokens = result.dkimTokens;
      updates.email_domain_verified = result.verified;
    } else {
      updates.email_domain = null;
      updates.email_domain_dkim_tokens = null;
      updates.email_domain_verified = false;
    }
  }

  if (Object.keys(updates).length > 0) {
    try {
      await org.updateOrganization(auth.tenantId, updates);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Unknown field:")) {
        return jsonResponse({ error: err.message }, 400);
      }
      throw err;
    }
  }

  // Refetch and return
  const row = await org.getOrganization(auth.tenantId);
  if (!row) {
    return jsonResponse({ error: "Organization not found" }, 404);
  }

  let dnsRecords: unknown[] = [];
  if (row.email_domain && row.email_domain_dkim_tokens) {
    dnsRecords = org.formatDnsRecords(row.email_domain, row.email_domain_dkim_tokens);
  }

  return jsonResponse({
    ...row,
    email_domain_verified: row.email_domain_verified ?? false,
    dns_records: dnsRecords,
  });
}
