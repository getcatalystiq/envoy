import { describe, expect, it, vi } from "vitest";

import {
  buildListUnsubscribeHeaders,
  createUnsubscribeToken,
  verifyUnsubscribeToken,
  handleUnsubscribe,
  checkRateLimit,
  clientIp,
  MIN_UNSUBSCRIBE_TTL_SECONDS,
  type UnsubscribeLandingConfig,
} from "@sdk/consent/unsubscribe.js";
import { createConsentMirror, type ConsentMirror } from "@sdk/consent/mirror.js";
import { createDb, type SdkPool } from "@sdk/db/pool.js";
import { createResendClientHandle } from "@sdk/resend/client.js";

const SECRET = "unsub-secret-0123456789";

// ---------------------------------------------------------------------------------------------
// Token sign / verify
// ---------------------------------------------------------------------------------------------

describe("createUnsubscribeToken / verifyUnsubscribeToken", () => {
  it("round-trips a valid token to its claims", () => {
    const now = 1_000_000;
    const token = createUnsubscribeToken(
      { email: "a@example.com", topicKey: "weekly", stream: "digest" },
      SECRET,
      now
    );
    const v = verifyUnsubscribeToken(token, SECRET, now + 10);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims.contact).toBe("a@example.com");
      expect(v.claims.topicKey).toBe("weekly");
      expect(v.claims.stream).toBe("digest");
      expect(v.claims.exp).toBe(now + MIN_UNSUBSCRIBE_TTL_SECONDS);
    }
  });

  it("Error: a forged signature is rejected (bad_signature)", () => {
    const token = createUnsubscribeToken(
      { email: "a@example.com", topicKey: "weekly", stream: "digest" },
      SECRET
    );
    const v = verifyUnsubscribeToken(token, "a-different-secret");
    expect(v).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("Error: a tampered payload is rejected (signature no longer matches)", () => {
    const token = createUnsubscribeToken(
      { email: "a@example.com", topicKey: "weekly", stream: "digest" },
      SECRET
    );
    const [, sig] = token.split(".");
    // swap the payload for a different contact, keep the old signature
    const forgedPayload = Buffer.from(
      JSON.stringify({
        contact: "victim@example.com",
        topicKey: "weekly",
        stream: "digest",
        exp: 9_999_999_999,
      })
    ).toString("base64url");
    const v = verifyUnsubscribeToken(`${forgedPayload}.${sig}`, SECRET);
    expect(v.ok).toBe(false);
  });

  it("Error: an expired token is rejected (expired)", () => {
    const now = 1_000_000;
    const token = createUnsubscribeToken(
      { email: "a@example.com", topicKey: "weekly", stream: "digest", ttlSeconds: MIN_UNSUBSCRIBE_TTL_SECONDS },
      SECRET,
      now
    );
    const past = now + MIN_UNSUBSCRIBE_TTL_SECONDS + 1; // 1s after expiry
    expect(verifyUnsubscribeToken(token, SECRET, past)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a malformed token without throwing", () => {
    expect(verifyUnsubscribeToken("", SECRET).ok).toBe(false);
    expect(verifyUnsubscribeToken("no-dot", SECRET).ok).toBe(false);
    expect(verifyUnsubscribeToken(".", SECRET).ok).toBe(false);
    expect(verifyUnsubscribeToken("a.", SECRET).ok).toBe(false);
    expect(verifyUnsubscribeToken("notbase64!.sig", SECRET).ok).toBe(false);
  });

  it("rejects a too-short TTL at mint time (fail loud, 60d floor)", () => {
    expect(() =>
      createUnsubscribeToken(
        { email: "a@example.com", topicKey: "weekly", stream: "digest", ttlSeconds: 60 },
        SECRET
      )
    ).toThrow(/60 days/);
  });
});

// ---------------------------------------------------------------------------------------------
// List-Unsubscribe header builder (RFC 8058)
// ---------------------------------------------------------------------------------------------

describe("buildListUnsubscribeHeaders", () => {
  it("builds RFC 8058 one-click headers with a signed token URL", () => {
    const headers = buildListUnsubscribeHeaders(
      { email: "a@example.com", topicKey: "weekly", stream: "digest" },
      SECRET,
      "https://app.example.com/api/envoy/unsubscribe"
    );
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(headers["List-Unsubscribe"]).toMatch(
      /^<https:\/\/app\.example\.com\/api\/envoy\/unsubscribe\?token=.+>$/
    );
    // the embedded token verifies
    const url = headers["List-Unsubscribe"].slice(1, -1);
    const token = new URL(url).searchParams.get("token")!;
    expect(verifyUnsubscribeToken(token, SECRET).ok).toBe(true);
  });

  it("appends with & when the base URL already has a query string", () => {
    const headers = buildListUnsubscribeHeaders(
      { email: "a@example.com", topicKey: "weekly", stream: "digest" },
      SECRET,
      "https://app.example.com/u?v=1"
    );
    expect(headers["List-Unsubscribe"]).toContain("?v=1&token=");
  });

  it("rejects a non-https base URL (RFC 8058)", () => {
    expect(() =>
      buildListUnsubscribeHeaders(
        { email: "a@example.com", topicKey: "weekly", stream: "digest" },
        SECRET,
        "http://app.example.com/u"
      )
    ).toThrow(/https/);
  });
});

// ---------------------------------------------------------------------------------------------
// Landing handler
// ---------------------------------------------------------------------------------------------

/** A pool that records consent upserts and serves a configurable rate-limit count. */
function fakeLandingPool(rateCount = 1) {
  const upserts: Array<ReadonlyArray<unknown>> = [];
  const pool: SdkPool = {
    query: vi.fn(async (text: string, params?: ReadonlyArray<unknown>) => {
      const t = text.trim();
      if (t.startsWith("INSERT INTO sdk_rate_limits")) {
        return { rows: [{ count: rateCount }] } as never;
      }
      if (t.startsWith("INSERT INTO sdk_topic_consent")) {
        upserts.push(params ?? []);
        // echo back a stored row so mirror.set's RETURNING is satisfied
        return {
          rows: [
            {
              contact: params?.[1],
              topic_key: params?.[2],
              topic_id: params?.[3] ?? null,
              digest_status: params?.[4] ?? "opt_out",
              alert_status: params?.[5] ?? "opt_in",
              dirty_since: "now",
            },
          ],
        } as never;
      }
      if (t.startsWith("SELECT contact, topic_key")) {
        return { rows: [] } as never;
      }
      return { rows: [] } as never;
    }),
  };
  return { pool, upserts };
}

function landingConfig(rateCount = 1): {
  config: UnsubscribeLandingConfig;
  mirror: ConsentMirror;
  upserts: Array<ReadonlyArray<unknown>>;
} {
  const { pool, upserts } = fakeLandingPool(rateCount);
  const db = createDb(pool, "prod");
  // Resend disabled → mirror.set push is a no-op; the landing still writes the mirror.
  const mirror = createConsentMirror(db, createResendClientHandle(undefined));
  return { config: { secret: SECRET, mirror, db }, mirror, upserts };
}

function unsubRequest(token: string | null, init?: { method?: string; ip?: string }): Request {
  const url =
    "https://app.example.com/api/envoy/unsubscribe" +
    (token === null ? "" : `?token=${encodeURIComponent(token)}`);
  const headers: Record<string, string> = {};
  if (init?.ip) headers["x-forwarded-for"] = init.ip;
  return new Request(url, { method: init?.method ?? "POST", headers });
}

describe("handleUnsubscribe", () => {
  it("Happy: a valid one-click POST writes a topic-scoped opt_out, returns 200 blank, no redirect", async () => {
    const { config, upserts } = landingConfig();
    const token = createUnsubscribeToken(
      { email: "a@example.com", topicKey: "weekly", stream: "digest" },
      SECRET
    );
    const res = await handleUnsubscribe(unsubRequest(token), config);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull(); // no redirect
    expect(await res.text()).toBe(""); // blank body
    // wrote a topic-scoped opt_out: the digest column param ($5) is opt_out, alert ($6) is null
    expect(upserts).toHaveLength(1);
    const params = upserts[0];
    expect(params[1]).toBe("prod:a@example.com"); // namespaced contact
    expect(params[2]).toBe("weekly");
    expect(params[4]).toBe("opt_out"); // digest stream set
    expect(params[5]).toBeNull(); // alert stream untouched (topic-scoped, not global)
  });

  it("Error: a forged token returns the SAME 200 blank and writes nothing (no oracle, no state change)", async () => {
    const { config, upserts } = landingConfig();
    const res = await handleUnsubscribe(unsubRequest("forged.token"), config);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(upserts).toHaveLength(0);
  });

  it("Error: an expired token returns 200 blank, writes nothing — uniform with the valid case", async () => {
    const { config, upserts } = landingConfig();
    const now = 1_000_000;
    const token = createUnsubscribeToken(
      { email: "a@example.com", topicKey: "weekly", stream: "digest" },
      SECRET,
      now - MIN_UNSUBSCRIBE_TTL_SECONDS - 100 // minted so it is already expired vs real now
    );
    const res = await handleUnsubscribe(unsubRequest(token), config);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(upserts).toHaveLength(0);
  });

  it("a missing token returns the uniform 200 (no oracle)", async () => {
    const { config, upserts } = landingConfig();
    const res = await handleUnsubscribe(unsubRequest(null), config);
    expect(res.status).toBe(200);
    expect(upserts).toHaveLength(0);
  });

  it("responses are byte-identical for valid vs forged vs already-unsubscribed (no oracle)", async () => {
    const valid = landingConfig();
    const forged = landingConfig();
    const token = createUnsubscribeToken(
      { email: "a@example.com", topicKey: "weekly", stream: "digest" },
      SECRET
    );
    const rValid = await handleUnsubscribe(unsubRequest(token), valid.config);
    const rForged = await handleUnsubscribe(unsubRequest("nope.sig"), forged.config);
    expect(rValid.status).toBe(rForged.status);
    expect(await rValid.text()).toBe(await rForged.text());
  });

  it("Edge: rate-limit trips after N requests → 429 (and still no token oracle)", async () => {
    // count returned > limit → not allowed
    const { config } = landingConfig(21); // default limit is 20
    const token = createUnsubscribeToken(
      { email: "a@example.com", topicKey: "weekly", stream: "digest" },
      SECRET
    );
    const res = await handleUnsubscribe(unsubRequest(token, { ip: "1.2.3.4" }), config);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("rejects a non-GET/POST method with 405", async () => {
    const { config } = landingConfig();
    const res = await handleUnsubscribe(
      unsubRequest("x.y", { method: "DELETE" }),
      config
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
  });

  it("accepts a GET one-click for browser-opened links", async () => {
    const { config, upserts } = landingConfig();
    const token = createUnsubscribeToken(
      { email: "a@example.com", topicKey: "weekly", stream: "alert" },
      SECRET
    );
    const res = await handleUnsubscribe(unsubRequest(token, { method: "GET" }), config);
    expect(res.status).toBe(200);
    expect(upserts).toHaveLength(1);
    expect(upserts[0][5]).toBe("opt_out"); // alert stream ($6)
  });
});

// ---------------------------------------------------------------------------------------------
// Rate limiter + clientIp
// ---------------------------------------------------------------------------------------------

describe("checkRateLimit", () => {
  it("allows while count <= limit, denies past it", async () => {
    const pool: SdkPool = {
      query: vi.fn(async () => ({ rows: [{ count: 5 }] }) as never),
    };
    const db = createDb(pool, "prod");
    const r = await checkRateLimit(db, "unsubscribe:1.2.3.4", 10, 60);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(5);

    const pool2: SdkPool = {
      query: vi.fn(async () => ({ rows: [{ count: 11 }] }) as never),
    };
    const db2 = createDb(pool2, "prod");
    const r2 = await checkRateLimit(db2, "unsubscribe:1.2.3.4", 10, 60);
    expect(r2.allowed).toBe(false);
    expect(r2.remaining).toBe(0);
  });

  it("FAILS OPEN when the limiter query errors (an outage must not block opt-out)", async () => {
    const pool: SdkPool = {
      query: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    const db = createDb(pool, "prod");
    const r = await checkRateLimit(db, "unsubscribe:1.2.3.4", 10, 60);
    expect(r.allowed).toBe(true);
  });

  it("namespaces the bucket key (KTD7)", async () => {
    const calls: Array<ReadonlyArray<unknown> | undefined> = [];
    const pool: SdkPool = {
      query: vi.fn(async (_text: string, params?: ReadonlyArray<unknown>) => {
        calls.push(params);
        return { rows: [{ count: 1 }] } as never;
      }),
    };
    const db = createDb(pool, "prod");
    await checkRateLimit(db, "unsubscribe:1.2.3.4", 10, 60);
    expect(calls[0]?.[1]).toBe("prod:unsubscribe:1.2.3.4");
  });
});

describe("clientIp", () => {
  it("reads the first x-forwarded-for hop", () => {
    const req = new Request("https://x/", {
      headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" },
    });
    expect(clientIp(req)).toBe("9.9.9.9");
  });

  it("falls back to x-real-ip then 'unknown'", () => {
    const req = new Request("https://x/", { headers: { "x-real-ip": "8.8.8.8" } });
    expect(clientIp(req)).toBe("8.8.8.8");
    expect(clientIp(new Request("https://x/"))).toBe("unknown");
  });
});
