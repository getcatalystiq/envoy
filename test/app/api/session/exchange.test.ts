import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/oauth", () => ({
  signAccessToken: vi.fn(),
  verifyCodeChallenge: vi.fn(),
}));
vi.mock("@/lib/queries/oauth", () => ({
  exchangeCode: vi.fn(),
  getClient: vi.fn(),
  getUserById: vi.fn(),
  createRefreshToken: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  clientIp: vi.fn(() => "1.2.3.4"),
}));

import { signAccessToken, verifyCodeChallenge } from "@/lib/oauth";
import {
  exchangeCode,
  getClient,
  getUserById,
  createRefreshToken,
} from "@/lib/queries/oauth";
import { checkRateLimit } from "@/lib/rate-limit";
import { POST } from "@/app/api/session/exchange/route";

const sign = signAccessToken as unknown as ReturnType<typeof vi.fn>;
const verifyPkce = verifyCodeChallenge as unknown as ReturnType<typeof vi.fn>;
const exchange = exchangeCode as unknown as ReturnType<typeof vi.fn>;
const getClientMock = getClient as unknown as ReturnType<typeof vi.fn>;
const getUser = getUserById as unknown as ReturnType<typeof vi.fn>;
const createRt = createRefreshToken as unknown as ReturnType<typeof vi.fn>;
const rl = checkRateLimit as unknown as ReturnType<typeof vi.fn>;

function req(body: unknown) {
  return new Request("http://x/api/session/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID = {
  client_id: "envoy_pub",
  code: "authcode",
  code_verifier: "verifier",
  redirect_uri: "https://app.example.com/callback",
};

beforeEach(() => {
  vi.clearAllMocks();
  rl.mockResolvedValue({ allowed: true, remaining: 30, retryAfterSeconds: 60 });
  verifyPkce.mockReturnValue(true);
  getClientMock.mockResolvedValue({ client_id: "envoy_pub", client_secret_hash: null });
  getUser.mockResolvedValue({ id: "u1", organization_id: "org1" });
  sign.mockResolvedValue("access-token");
  createRt.mockResolvedValue({ token: "refresh-token" });
  exchange.mockResolvedValue({
    client_id: "envoy_pub",
    redirect_uri: "https://app.example.com/callback",
    code_challenge: "challenge",
    user_id: "u1",
    scope: "read write admin",
  });
});

describe("POST /api/session/exchange", () => {
  it("sets an httpOnly refresh cookie and returns the access token on success", async () => {
    const res = await POST(req(VALID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBe("access-token");
    expect(body.scope).toBe("read write admin");
    const cookie = res.headers.get("Set-Cookie") || "";
    expect(cookie).toContain("envoy_rt=refresh-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    // refresh token must NOT be in the JSON body
    expect(JSON.stringify(body)).not.toContain("refresh-token");
  });

  it("400s on missing required fields", async () => {
    const res = await POST(req({ client_id: "x" }));
    expect(res.status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("400s on an invalid/expired code", async () => {
    exchange.mockResolvedValueOnce(null);
    expect((await POST(req(VALID))).status).toBe(400);
  });

  it("400s on client_id mismatch", async () => {
    exchange.mockResolvedValueOnce({
      client_id: "someone_else",
      redirect_uri: VALID.redirect_uri,
      code_challenge: "challenge",
      user_id: "u1",
      scope: "read",
    });
    expect((await POST(req(VALID))).status).toBe(400);
  });

  it("400s on PKCE verifier mismatch", async () => {
    verifyPkce.mockReturnValueOnce(false);
    const res = await POST(req(VALID));
    expect(res.status).toBe(400);
    expect(sign).not.toHaveBeenCalled();
  });

  it("rejects a confidential client (must use /api/oauth/token)", async () => {
    getClientMock.mockResolvedValueOnce({ client_id: "envoy_pub", client_secret_hash: "hash" });
    const res = await POST(req(VALID));
    expect(res.status).toBe(400);
    expect(sign).not.toHaveBeenCalled();
  });

  it("400s when the user is missing/inactive (getUserById null)", async () => {
    getUser.mockResolvedValueOnce(null);
    expect((await POST(req(VALID))).status).toBe(400);
  });

  it("429s when rate limited", async () => {
    rl.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
    expect((await POST(req(VALID))).status).toBe(429);
  });
});
