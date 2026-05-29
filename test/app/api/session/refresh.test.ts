import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/oauth", () => ({
  signAccessToken: vi.fn(),
}));
vi.mock("@/lib/queries/oauth", () => ({
  verifyRefreshToken: vi.fn(),
  revokeRefreshToken: vi.fn(),
  createRefreshToken: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  clientIp: vi.fn(() => "1.2.3.4"),
}));

import { signAccessToken } from "@/lib/oauth";
import {
  verifyRefreshToken,
  revokeRefreshToken,
  createRefreshToken,
} from "@/lib/queries/oauth";
import { checkRateLimit } from "@/lib/rate-limit";
import { POST } from "@/app/api/session/refresh/route";

const sign = signAccessToken as unknown as ReturnType<typeof vi.fn>;
const verify = verifyRefreshToken as unknown as ReturnType<typeof vi.fn>;
const revoke = revokeRefreshToken as unknown as ReturnType<typeof vi.fn>;
const createRt = createRefreshToken as unknown as ReturnType<typeof vi.fn>;
const rl = checkRateLimit as unknown as ReturnType<typeof vi.fn>;

function req(cookie?: string) {
  return new Request("http://x/api/session/refresh", {
    method: "POST",
    headers: cookie ? { cookie } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rl.mockResolvedValue({ allowed: true, remaining: 60, retryAfterSeconds: 60 });
  sign.mockResolvedValue("new-access-token");
  createRt.mockResolvedValue({ token: "new-refresh-token" });
  revoke.mockResolvedValue(true);
});

describe("POST /api/session/refresh", () => {
  it("401s with no session cookie (and does not touch the DB)", async () => {
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
  });

  it("401s and clears the cookie when the refresh token is invalid/deactivated", async () => {
    verify.mockResolvedValueOnce(null);
    const res = await POST(req("envoy_rt=stale"));
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("rotates the token and returns a fresh access token on success", async () => {
    verify.mockResolvedValueOnce({
      user_id: "u1",
      org_id: "org1",
      client_id: "c1",
      scopes: ["read", "write", "admin"],
      user_scopes: ["read", "write", "admin"],
    });
    const res = await POST(req("envoy_rt=good"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBe("new-access-token");
    // old token revoked, new one minted + set as httpOnly cookie
    expect(revoke).toHaveBeenCalledWith("good");
    expect(createRt).toHaveBeenCalled();
    const cookie = res.headers.get("Set-Cookie") || "";
    expect(cookie).toContain("envoy_rt=new-refresh-token");
    expect(cookie).toContain("HttpOnly");
  });

  it("intersects granted scopes with current user scopes (downgrade on refresh)", async () => {
    verify.mockResolvedValueOnce({
      user_id: "u1",
      org_id: "org1",
      client_id: "c1",
      scopes: ["read", "write", "admin"],
      user_scopes: ["read"], // user was downgraded
    });
    const res = await POST(req("envoy_rt=good"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe("read");
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ scope: "read" }));
  });

  it("401s when the user retains none of the token's scopes", async () => {
    verify.mockResolvedValueOnce({
      user_id: "u1",
      org_id: "org1",
      client_id: "c1",
      scopes: ["admin"],
      user_scopes: ["read"],
    });
    const res = await POST(req("envoy_rt=good"));
    expect(res.status).toBe(401);
    expect(sign).not.toHaveBeenCalled();
  });

  it("429s when rate limited", async () => {
    rl.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
    const res = await POST(req("envoy_rt=good"));
    expect(res.status).toBe(429);
    expect(verify).not.toHaveBeenCalled();
  });
});
