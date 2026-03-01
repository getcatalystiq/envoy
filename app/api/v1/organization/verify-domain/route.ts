import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as org from "@/lib/queries/organization";
import {
  getDomainVerificationStatus,
  createConfigurationSet,
  addSnsEventDestination,
} from "@/lib/ses";
import { getEnv } from "@/lib/env";

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const domainInfo = await org.getDomainVerificationStatus(auth.tenantId);
  if (!domainInfo || !domainInfo.email_domain) {
    return jsonResponse({ error: "No email domain configured" }, 400);
  }

  const result = await getDomainVerificationStatus(domainInfo.email_domain);
  const isVerified = result.verified === true;
  let tenantName = domainInfo.ses_tenant_name;
  let configSetName = domainInfo.ses_configuration_set;

  const env = getEnv();

  // Create SES tenant with configuration set when domain becomes verified
  if (isVerified && !tenantName && env.SES_NOTIFICATION_TOPIC_ARN) {
    tenantName = `envoy-${auth.tenantId}`;
    configSetName = `envoy-${auth.tenantId}`;

    try {
      await createConfigurationSet(configSetName);
      await addSnsEventDestination(configSetName, env.SES_NOTIFICATION_TOPIC_ARN);
    } catch {
      // Log but don't fail - domain verification is more important
      tenantName = null;
      configSetName = null;
    }
  }

  await org.updateDomainVerification(
    auth.tenantId,
    isVerified,
    (result.dkimTokens as string[]) ?? [],
    tenantName,
    configSetName
  );

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
