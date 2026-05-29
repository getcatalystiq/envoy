import { describe, it, expect } from "vitest";
import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { signAccessToken } from "@/lib/oauth";

async function authedRequest(opts: { scope?: string; tenantId?: string; userId?: string }): Promise<Request> {
  const token = await signAccessToken({
    userId: opts.userId ?? "user-1",
    tenantId: opts.tenantId ?? "org-1",
    scope: opts.scope ?? "admin",
    clientId: "client-1",
  });
  return new Request("http://x/", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("lib/admin-auth", () => {
  describe("requireAdmin", () => {
    it("returns AuthContext when token has admin scope", async () => {
      const req = await authedRequest({ scope: "admin", tenantId: "t-7", userId: "u-7" });
      const result = await requireAdmin(req);
      expect(isErrorResponse(result)).toBe(false);
      if (!isErrorResponse(result)) {
        expect(result.tenantId).toBe("t-7");
        expect(result.userId).toBe("u-7");
        expect(result.scope).toBe("admin");
      }
    });

    it("accepts write scope as well", async () => {
      const req = await authedRequest({ scope: "write read" });
      const result = await requireAdmin(req);
      expect(isErrorResponse(result)).toBe(false);
    });

    it("returns 401 when no bearer token", async () => {
      const req = new Request("http://x/");
      const result = await requireAdmin(req);
      expect(isErrorResponse(result)).toBe(true);
      if (isErrorResponse(result)) expect(result.status).toBe(401);
    });

    it("returns 401 when token is invalid", async () => {
      const req = new Request("http://x/", {
        headers: { authorization: "Bearer not.a.jwt" },
      });
      const result = await requireAdmin(req);
      expect(isErrorResponse(result)).toBe(true);
      if (isErrorResponse(result)) expect(result.status).toBe(401);
    });

    it("returns 403 when token has neither admin nor write scope", async () => {
      const req = await authedRequest({ scope: "read" });
      const result = await requireAdmin(req);
      expect(isErrorResponse(result)).toBe(true);
      if (isErrorResponse(result)) expect(result.status).toBe(403);
    });

    it("treats space-separated scopes correctly", async () => {
      const req = await authedRequest({ scope: "openid email admin" });
      const result = await requireAdmin(req);
      expect(isErrorResponse(result)).toBe(false);
    });
  });

  describe("isErrorResponse", () => {
    it("returns true for Response", () => {
      expect(isErrorResponse(new Response("x", { status: 401 }))).toBe(true);
    });

    it("returns false for AuthContext", () => {
      expect(isErrorResponse({ userId: "u", tenantId: "t", scope: "admin" })).toBe(false);
    });
  });
});
