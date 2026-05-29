import { describe, it, expect, vi, beforeEach } from "vitest";

// The GET handler auto-registers OAuth clients (INSERT via createClient) for an
// unknown/missing client_id. That write must be gated by the per-IP rate limit
// FIRST, so an attacker can't flood the client table by hammering the endpoint.
// These tests pin that ordering: a blocked limiter short-circuits to 429 before
// any auto-registration happens.

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  clientIp: vi.fn(() => "1.2.3.4"),
}));

vi.mock("@/lib/queries/oauth", () => ({
  getClient: vi.fn(),
  createClient: vi.fn(),
  validateRedirectUri: vi.fn(),
}));

vi.mock("@/lib/oauth", () => ({
  isAllowedRedirectUri: vi.fn(() => true),
  AUTH_CODE_EXPIRE_MINUTES: 10,
}));

vi.mock("@/lib/oauth-html", () => ({
  renderLoginForm: vi.fn(() => "<html>login</html>"),
}));

import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { getClient, createClient } from "@/lib/queries/oauth";
import { renderLoginForm } from "@/lib/oauth-html";
import { GET } from "@/app/api/oauth/authorize/route";

const checkRateLimitMock = checkRateLimit as unknown as ReturnType<typeof vi.fn>;
const clientIpMock = clientIp as unknown as ReturnType<typeof vi.fn>;
const getClientMock = getClient as unknown as ReturnType<typeof vi.fn>;
const createClientMock = createClient as unknown as ReturnType<typeof vi.fn>;
const renderLoginFormMock = renderLoginForm as unknown as ReturnType<typeof vi.fn>;

// Build a GET Request with the PKCE params the handler requires. No client_id by
// default, which routes into the auto-registration (createClient) branch.
function authorizeRequest(extra: Record<string, string> = {}): Request {
  const params = new URLSearchParams({
    redirect_uri: "https://claude.ai/callback",
    response_type: "code",
    code_challenge: "abc123challenge",
    ...extra,
  });
  return new Request(`http://localhost/api/oauth/authorize?${params.toString()}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  clientIpMock.mockReturnValue("1.2.3.4");
});

describe("GET /api/oauth/authorize — rate limit gates auto-registration", () => {
  it("Case A: returns 429 and never auto-registers when the limiter blocks", async () => {
    checkRateLimitMock.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 60,
    });

    const res = await GET(authorizeRequest());

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    // The blocked request must short-circuit before any client-table write.
    expect(createClientMock).not.toHaveBeenCalled();
    expect(getClientMock).not.toHaveBeenCalled();
    expect(renderLoginFormMock).not.toHaveBeenCalled();
  });

  it("Case B: auto-registers and returns 200 HTML when the limiter allows", async () => {
    checkRateLimitMock.mockResolvedValueOnce({
      allowed: true,
      retryAfterSeconds: 60,
    });
    createClientMock.mockResolvedValueOnce({ client_id: "auto-generated-id" });

    const res = await GET(authorizeRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html");
    await expect(res.text()).resolves.toBe("<html>login</html>");

    // With no client_id supplied, the allowed path performs auto-registration.
    expect(createClientMock).toHaveBeenCalledOnce();
    // getClient is only consulted when a client_id is present; not here.
    expect(getClientMock).not.toHaveBeenCalled();

    // The newly minted client_id is threaded into the rendered login form.
    expect(renderLoginFormMock).toHaveBeenCalledOnce();
    const formArgs = renderLoginFormMock.mock.calls[0][0];
    expect(formArgs.clientId).toBe("auto-generated-id");
    expect(formArgs.redirectUri).toBe("https://claude.ai/callback");
    expect(formArgs.codeChallenge).toBe("abc123challenge");
  });
});
