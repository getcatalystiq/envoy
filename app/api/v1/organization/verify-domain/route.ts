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

  // Create SES tenant with configuration set when domain becomes verified.
  // The SES helpers return { success: false } instead of throwing, so we must
  // check the result — otherwise we persist a configuration-set name that AWS
  // never created, and every later send fails with NotFoundException.
  if (isVerified && !tenantName && env.SES_NOTIFICATION_TOPIC_ARN) {
    const candidate = `envoy-${auth.tenantId}`;

    const created = await createConfigurationSet(candidate);
    if (created.success) {
      const dest = await addSnsEventDestination(
        candidate,
        env.SES_NOTIFICATION_TOPIC_ARN,
      );
      if (dest.success) {
        // Only persist once both AWS calls actually succeeded.
        tenantName = candidate;
        configSetName = candidate;
      } else {
        console.error("SES event destination setup failed", dest);
      }
    } else {
      console.error("SES configuration set creation failed", created);
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
