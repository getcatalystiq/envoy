import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the route's collaborators so we exercise only the POST handler logic.
vi.mock("@/lib/oauth", () => ({
  verifyCsrfToken: vi.fn(),
  isAllowedRedirectUri: vi.fn(),
  AUTH_CODE_EXPIRE_MINUTES: 10,
}));

vi.mock("@/lib/queries/oauth", () => ({
  getClient: vi.fn(),
  validateRedirectUri: vi.fn(),
  authenticateUser: vi.fn(),
  createAuthorizationCode: vi.fn(),
  // createClient is imported by the module but only used by the GET handler.
  createClient: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/oauth-html", () => ({
  renderLoginForm: vi.fn(() => "<html>login</html>"),
}));

import {
  verifyCsrfToken,
  isAllowedRedirectUri,
} from "@/lib/oauth";
import {
  getClient,
  validateRedirectUri,
  authenticateUser,
  createAuthorizationCode,
} from "@/lib/queries/oauth";
import { checkRateLimit } from "@/lib/rate-limit";
import { renderLoginForm } from "@/lib/oauth-html";

import { POST } from "@/app/api/oauth/authorize/route";

const verifyCsrfTokenMock = verifyCsrfToken as unknown as ReturnType<typeof vi.fn>;
const isAllowedRedirectUriMock = isAllowedRedirectUri as unknown as ReturnType<typeof vi.fn>;
const getClientMock = getClient as unknown as ReturnType<typeof vi.fn>;
const validateRedirectUriMock = validateRedirectUri as unknown as ReturnType<typeof vi.fn>;
const authenticateUserMock = authenticateUser as unknown as ReturnType<typeof vi.fn>;
const createAuthorizationCodeMock = createAuthorizationCode as unknown as ReturnType<typeof vi.fn>;
const checkRateLimitMock = checkRateLimit as unknown as ReturnType<typeof vi.fn>;
const renderLoginFormMock = renderLoginForm as unknown as ReturnType<typeof vi.fn>;

const REDIRECT_URI = "https://app.example.com/callback";

function postRequest(fields: Record<string, string>): Request {
  const form = new URLSearchParams(fields);
  return new Request("http://localhost/api/oauth/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function validFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    csrf_token: "csrf-ok",
    client_id: "client-123",
    redirect_uri: REDIRECT_URI,
    scope: "read write",
    state: "xyz-state",
    code_challenge: "challenge-abc",
    code_challenge_method: "S256",
    email: "user@example.com",
    password: "hunter2",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults for the happy path; individual tests override as needed.
  checkRateLimitMock.mockResolvedValue({
    allowed: true,
    remaining: 9,
    retryAfterSeconds: 0,
  });
  verifyCsrfTokenMock.mockReturnValue(true);
  getClientMock.mockResolvedValue({ client_id: "client-123" });
  validateRedirectUriMock.mockResolvedValue(true);
  isAllowedRedirectUriMock.mockReturnValue(true);
  authenticateUserMock.mockResolvedValue({
    id: "user-1",
    scopes: ["read", "write"],
  });
  createAuthorizationCodeMock.mockResolvedValue(undefined);
});

describe("POST /api/oauth/authorize", () => {
  it("happy path: issues a 302 redirect with ?code= and preserves state", async () => {
    const res = await POST(postRequest(validFields()));

    expect(res.status).toBe(302);
    const location = res.headers.get("Location");
    expect(location).toBeTruthy();

    const loc = new URL(location!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT_URI);
    expect(loc.searchParams.get("code")).toBeTruthy();
    expect(loc.searchParams.get("state")).toBe("xyz-state");

    // The issued code persists exactly once with the round-tripped PKCE params.
    expect(createAuthorizationCodeMock).toHaveBeenCalledTimes(1);
    const args = createAuthorizationCodeMock.mock.calls[0];
    // (code, clientId, userId, redirectUri, scope, codeChallenge, method, expiry)
    expect(args[1]).toBe("client-123");
    expect(args[2]).toBe("user-1");
    expect(args[3]).toBe(REDIRECT_URI);
    expect(args[5]).toBe("challenge-abc");
    expect(args[6]).toBe("S256");
    expect(args[7]).toBe(10); // AUTH_CODE_EXPIRE_MINUTES mock value
    // The code in the query must match the code in the redirect.
    expect(args[0]).toBe(loc.searchParams.get("code"));
  });

  it("tampered redirect_uri (validateRedirectUri -> false) returns 400, NOT a 302, and never issues a code", async () => {
    validateRedirectUriMock.mockResolvedValue(false);

    const res = await POST(
      postRequest(validFields({ redirect_uri: "https://attacker.example/steal" })),
    );

    // Critical: a bad redirect_uri must never become a redirect target.
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(302);
    expect(res.headers.get("Location")).toBeNull();

    const body = await res.json();
    expect(body.error).toBe("invalid_request");

    // No authorization code may be minted on the mismatch path.
    expect(createAuthorizationCodeMock).not.toHaveBeenCalled();
    // Should short-circuit before authenticating the user.
    expect(authenticateUserMock).not.toHaveBeenCalled();
  });

  it("falls back to isAllowedRedirectUri for unknown clients and 400s when not allowed", async () => {
    getClientMock.mockResolvedValue(null);
    isAllowedRedirectUriMock.mockReturnValue(false);

    const res = await POST(postRequest(validFields()));

    expect(res.status).toBe(400);
    expect(validateRedirectUriMock).not.toHaveBeenCalled();
    expect(isAllowedRedirectUriMock).toHaveBeenCalledWith(REDIRECT_URI);
    expect(createAuthorizationCodeMock).not.toHaveBeenCalled();
  });

  it("non-S256 code_challenge_method returns 400 (PKCE enforced at issuance)", async () => {
    const res = await POST(
      postRequest(validFields({ code_challenge_method: "plain" })),
    );

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(302);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toContain("S256");
    expect(createAuthorizationCodeMock).not.toHaveBeenCalled();
  });

  it("missing code_challenge returns 400 even with S256 method", async () => {
    const res = await POST(
      postRequest(validFields({ code_challenge: "" })),
    );

    expect(res.status).toBe(400);
    expect(createAuthorizationCodeMock).not.toHaveBeenCalled();
  });

  it("invalid CSRF token re-renders the login form with 403 and never issues a code", async () => {
    verifyCsrfTokenMock.mockReturnValue(false);

    const res = await POST(postRequest(validFields()));

    expect(res.status).toBe(403);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(renderLoginFormMock).toHaveBeenCalled();
    expect(createAuthorizationCodeMock).not.toHaveBeenCalled();
  });

  it("returns 429 when the per-IP rate limit is exceeded", async () => {
    checkRateLimitMock.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 60,
    });

    const res = await POST(postRequest(validFields()));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    // Rejected before any CSRF/redirect/auth processing.
    expect(verifyCsrfTokenMock).not.toHaveBeenCalled();
    expect(createAuthorizationCodeMock).not.toHaveBeenCalled();
  });

  it("returns 429 when the per-email rate limit is exceeded (second limiter call)", async () => {
    // First call = IP limiter (allowed), second = email limiter (blocked).
    checkRateLimitMock
      .mockResolvedValueOnce({ allowed: true, remaining: 9, retryAfterSeconds: 0 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 300 });

    const res = await POST(postRequest(validFields()));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("300");
    expect(authenticateUserMock).not.toHaveBeenCalled();
    expect(createAuthorizationCodeMock).not.toHaveBeenCalled();
  });

  it("bad credentials re-render the login form (200) and never issue a code", async () => {
    authenticateUserMock.mockResolvedValue(null);

    const res = await POST(postRequest(validFields()));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(renderLoginFormMock).toHaveBeenCalled();
    expect(createAuthorizationCodeMock).not.toHaveBeenCalled();
  });

  it("omits state from the redirect when none was supplied", async () => {
    const res = await POST(postRequest(validFields({ state: "" })));

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.searchParams.get("code")).toBeTruthy();
    expect(loc.searchParams.has("state")).toBe(false);
  });

  it("grants only the intersection of requested and user scopes", async () => {
    authenticateUserMock.mockResolvedValue({ id: "user-1", scopes: ["read"] });

    const res = await POST(postRequest(validFields({ scope: "read write" })));

    expect(res.status).toBe(302);
    const scopeArg = createAuthorizationCodeMock.mock.calls[0][4];
    expect(scopeArg).toBe("read");
  });
});
