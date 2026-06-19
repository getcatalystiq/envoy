import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/admin-auth", () => ({
  requireAdmin: vi.fn(async () => ({ tenantId: "org1" })),
  isErrorResponse: vi.fn(() => false),
}));

vi.mock("@/lib/queries/organization", () => ({
  getDomainVerificationStatus: vi.fn(async () => ({
    email_domain: "easypassport.co",
    ses_tenant_name: null,
    ses_configuration_set: null,
  })),
  updateDomainVerification: vi.fn(async () => undefined),
  getOrganization: vi.fn(async () => ({
    email_domain: "easypassport.co",
    email_domain_dkim_tokens: ["t1"],
    email_domain_verified: true,
  })),
  formatDnsRecords: vi.fn(() => []),
}));

vi.mock("@/lib/ses", () => ({
  getDomainVerificationStatus: vi.fn(async () => ({
    verified: true,
    dkimTokens: ["t1"],
  })),
  createConfigurationSet: vi.fn(),
  addSnsEventDestination: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn(() => ({ SES_NOTIFICATION_TOPIC_ARN: "arn:topic" })),
}));

import { POST } from "@/app/api/v1/organization/verify-domain/route";
import * as org from "@/lib/queries/organization";
import { createConfigurationSet, addSnsEventDestination } from "@/lib/ses";

const req = () => new Request("http://localhost/api/v1/organization/verify-domain", { method: "POST" });

// Positional args of updateDomainVerification(tenantId, verified, tokens, tenantName, configSetName)
const lastUpdateArgs = () =>
  (org.updateDomainVerification as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [];

describe("POST verify-domain — configuration set persistence", () => {
  beforeEach(() => {
    vi.mocked(createConfigurationSet).mockReset();
    vi.mocked(addSnsEventDestination).mockReset();
    (org.updateDomainVerification as ReturnType<typeof vi.fn>).mockClear();
  });

  it("persists the config set name only when create AND dest both succeed", async () => {
    vi.mocked(createConfigurationSet).mockResolvedValue({ success: true });
    vi.mocked(addSnsEventDestination).mockResolvedValue({ success: true });

    await POST(req());

    const args = lastUpdateArgs();
    expect(args[3]).toBe("envoy-org1"); // tenantName
    expect(args[4]).toBe("envoy-org1"); // configSetName
  });

  it("does NOT persist a phantom name when create fails (and does not throw)", async () => {
    vi.mocked(createConfigurationSet).mockResolvedValue({
      success: false,
      errorCode: "AccessDeniedException",
    });
    vi.mocked(addSnsEventDestination).mockResolvedValue({ success: true });

    await POST(req());

    const args = lastUpdateArgs();
    expect(args[3]).toBeNull();
    expect(args[4]).toBeNull();
    // dest must not be attempted if create failed
    expect(addSnsEventDestination).not.toHaveBeenCalled();
  });

  it("does NOT persist a name when the event destination fails", async () => {
    vi.mocked(createConfigurationSet).mockResolvedValue({ success: true });
    vi.mocked(addSnsEventDestination).mockResolvedValue({
      success: false,
      errorCode: "AccessDeniedException",
    });

    await POST(req());

    const args = lastUpdateArgs();
    expect(args[3]).toBeNull();
    expect(args[4]).toBeNull();
  });
});
