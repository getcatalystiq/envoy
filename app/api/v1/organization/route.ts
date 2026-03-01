import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as org from "@/lib/queries/organization";
import { verifyDomain, getDomainVerificationStatus as getSESStatus } from "@/lib/ses";

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
  const { email_from_name, email_domain } = body;

  const updates: Record<string, unknown> = {};

  if (email_from_name !== undefined) {
    updates.email_from_name = email_from_name;
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
    await org.updateOrganization(auth.tenantId, updates);
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
