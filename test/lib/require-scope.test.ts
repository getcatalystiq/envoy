import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the oauth module so we can drive token extraction + verification
// directly, without signing real JWTs. requireScope depends only on
// extractBearerToken (to decide 401) and verifyAccessToken (to read scope).
vi.mock("@/lib/oauth", () => ({
  extractBearerToken: vi.fn(),
  verifyAccessToken: vi.fn(),
}));

import { extractBearerToken, verifyAccessToken } from "@/lib/oauth";
import { requireScope, isErrorResponse } from "@/lib/admin-auth";

const extractBearerTokenMock = extractBearerToken as unknown as ReturnType<
  typeof vi.fn
>;
const verifyAccessTokenMock = verifyAccessToken as unknown as ReturnType<
  typeof vi.fn
>;

// Configure the mocks to behave as if a valid token carrying `scope` was
// presented in the Authorization header.
function withToken(scope: string) {
  extractBearerTokenMock.mockReturnValue("a.valid.token");
  verifyAccessTokenMock.mockResolvedValue({
    sub: "user-1",
    tenant_id: "org-1",
    scope,
    client_id: "client-1",
    token_type: "access_token",
  });
}

// Configure the mocks to behave as if no Authorization header was present.
function withoutToken() {
  extractBearerTokenMock.mockReturnValue(null);
}

const req = new Request("http://x/");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lib/admin-auth requireScope", () => {
  describe("admin token", () => {
    it("passes requireScope('admin')", async () => {
      withToken("admin");
      const result = await requireScope(req, "admin");
      expect(isErrorResponse(result)).toBe(false);
      if (!isErrorResponse(result)) {
        expect(result.scope).toBe("admin");
        expect(result.tenantId).toBe("org-1");
        expect(result.userId).toBe("user-1");
      }
    });

    it("passes requireScope('write') (admin ⊃ write)", async () => {
      withToken("admin");
      const result = await requireScope(req, "write");
      expect(isErrorResponse(result)).toBe(false);
    });

    it("passes requireScope('read') (admin ⊃ read)", async () => {
      withToken("admin");
      const result = await requireScope(req, "read");
      expect(isErrorResponse(result)).toBe(false);
    });
  });

  describe("write-only token", () => {
    it("gets 403 on requireScope('admin')", async () => {
      withToken("write");
      const result = await requireScope(req, "admin");
      expect(isErrorResponse(result)).toBe(true);
      if (isErrorResponse(result)) {
        expect(result.status).toBe(403);
        const body = await result.json();
        expect(body.error).toBe("admin scope required");
      }
    });

    it("passes requireScope('write')", async () => {
      withToken("write");
      const result = await requireScope(req, "write");
      expect(isErrorResponse(result)).toBe(false);
      if (!isErrorResponse(result)) {
        expect(result.scope).toBe("write");
      }
    });

    it("passes requireScope('read') (write ⊃ read)", async () => {
      withToken("write");
      const result = await requireScope(req, "read");
      expect(isErrorResponse(result)).toBe(false);
    });
  });

  describe("read-only token", () => {
    it("gets 403 on requireScope('write')", async () => {
      withToken("read");
      const result = await requireScope(req, "write");
      expect(isErrorResponse(result)).toBe(true);
      if (isErrorResponse(result)) {
        expect(result.status).toBe(403);
        const body = await result.json();
        expect(body.error).toBe("write scope required");
      }
    });

    it("gets 403 on requireScope('admin')", async () => {
      withToken("read");
      const result = await requireScope(req, "admin");
      expect(isErrorResponse(result)).toBe(true);
      if (isErrorResponse(result)) expect(result.status).toBe(403);
    });

    it("passes requireScope('read')", async () => {
      withToken("read");
      const result = await requireScope(req, "read");
      expect(isErrorResponse(result)).toBe(false);
    });
  });

  describe("space-separated scopes", () => {
    it("uses the highest-ranked scope held (read write admin -> passes admin)", async () => {
      withToken("openid email read write admin");
      const result = await requireScope(req, "admin");
      expect(isErrorResponse(result)).toBe(false);
    });

    it("ignores unknown scopes; 'openid email' alone fails read", async () => {
      withToken("openid email");
      const result = await requireScope(req, "read");
      expect(isErrorResponse(result)).toBe(true);
      if (isErrorResponse(result)) expect(result.status).toBe(403);
    });
  });

  describe("missing token", () => {
    it("returns 401 when no bearer token is present", async () => {
      withoutToken();
      const result = await requireScope(req, "read");
      expect(isErrorResponse(result)).toBe(true);
      if (isErrorResponse(result)) {
        expect(result.status).toBe(401);
        const body = await result.json();
        expect(body.error).toBe("Bearer token required");
      }
      // verifyAccessToken should never be reached without a token.
      expect(verifyAccessTokenMock).not.toHaveBeenCalled();
    });
  });

  describe("invalid token", () => {
    it("returns 401 when verifyAccessToken throws", async () => {
      extractBearerTokenMock.mockReturnValue("bad.token");
      verifyAccessTokenMock.mockRejectedValue(new Error("expired"));
      const result = await requireScope(req, "read");
      expect(isErrorResponse(result)).toBe(true);
      if (isErrorResponse(result)) {
        expect(result.status).toBe(401);
        const body = await result.json();
        expect(body.error).toBe("Invalid or expired token");
      }
    });
  });
});
