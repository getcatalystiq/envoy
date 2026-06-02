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
  const { email_from_name, email_domain, agent_id, environment_id } = body;

  const updates: Record<string, unknown> = {};

  if (email_from_name !== undefined) {
    updates.email_from_name = email_from_name;
  }

  if (agent_id !== undefined) {
    // Accept null / empty string to unconfigure; otherwise require a non-empty
    // trimmed string.
    if (agent_id === null || agent_id === "") {
      updates.agent_id = null;
    } else if (typeof agent_id === "string" && agent_id.trim().length > 0) {
      updates.agent_id = agent_id.trim();
    } else {
      return jsonResponse(
        { error: "agent_id must be a non-empty string or null" },
        400,
      );
    }
  }

  if (environment_id !== undefined) {
    // null / empty clears the per-org override (deployment default is used).
    if (environment_id === null || environment_id === "") {
      updates.environment_id = null;
    } else if (
      typeof environment_id === "string" &&
      environment_id.trim().length > 0
    ) {
      updates.environment_id = environment_id.trim();
    } else {
      return jsonResponse(
        { error: "environment_id must be a non-empty string or null" },
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
      // UNIQUE(agent_id) violation — another org already uses this agent.
      const code = (err as { code?: string }).code;
      if (
        code === "23505" ||
        (err instanceof Error &&
          /uq_organizations_agent_id|duplicate key/i.test(err.message))
      ) {
        return jsonResponse(
          { error: "agent_id is already in use by another organization" },
          409,
        );
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
