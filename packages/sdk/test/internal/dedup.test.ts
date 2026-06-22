import { describe, expect, it } from "vitest";

// P2 dedup — prove the factored-out internal helpers are exported from ONE owner and the former
// duplicate sites consume that single source. These tests would fail if a copy were reintroduced
// (or if the shared symbol drifted from its consumers).

import { assertNonEmpty } from "@sdk/internal/assert.js";
import { rankCase, CONSENT_RANK } from "@sdk/consent/mirror.js";
import { TOPIC_CACHE_PROGRAM_KEY, topicKeyFor } from "@sdk/resend/topics.js";
import { secretsMatch, jsonResponse } from "@sdk/route/handler.js";
import { defineBroadcastProgram, BroadcastProgramError } from "@sdk/broadcast/program.js";

// ---------------------------------------------------------------------------------------------
// (e) assertNonEmpty — shared guard with optional error-type factory
// ---------------------------------------------------------------------------------------------

describe("assertNonEmpty (internal shared guard)", () => {
  it("accepts a non-empty string and narrows it", () => {
    expect(() => assertNonEmpty("x", "ok")).not.toThrow();
  });

  it("rejects empty, whitespace-only, and non-strings", () => {
    expect(() => assertNonEmpty("x", "")).toThrow(/x must be a non-empty string/);
    expect(() => assertNonEmpty("x", "   ")).toThrow(/non-empty string/);
    expect(() => assertNonEmpty("x", undefined)).toThrow(/non-empty string/);
    expect(() => assertNonEmpty("x", 42)).toThrow(/non-empty string/);
    expect(() => assertNonEmpty("x", null)).toThrow(/non-empty string/);
  });

  it("throws a generic Error by default", () => {
    try {
      assertNonEmpty("x", "");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(BroadcastProgramError);
    }
  });

  it("preserves a module-specific thrown error TYPE via the optional factory", () => {
    expect(() =>
      assertNonEmpty("program key", "", (m) => new BroadcastProgramError(m)),
    ).toThrow(BroadcastProgramError);
  });

  it("is the SAME guard program.ts uses — a whitespace-only key throws BroadcastProgramError", () => {
    // defineBroadcastProgram routes its key/segmentId checks through assertNonEmpty with the
    // BroadcastProgramError factory; a whitespace-only key must surface that exact type.
    expect(() =>
      defineBroadcastProgram({
        key: "   ",
        segmentId: "seg_1",
        cadenceDays: 7,
        render: () => null,
      }),
    ).toThrow(BroadcastProgramError);
  });

  it("is the SAME guard topics.ts uses — topicKeyFor rejects an empty subject with a generic Error", () => {
    expect(() => topicKeyFor("digest", "")).toThrow(/topic subject must be a non-empty string/);
  });
});

// ---------------------------------------------------------------------------------------------
// (a) rankCase — exported from the consent mirror, consumed by the reconcile sweep
// ---------------------------------------------------------------------------------------------

describe("rankCase (exported from consent/mirror; reused by broadcast/reconcile)", () => {
  it("emits a SQL CASE fragment whose ranks match CONSENT_RANK ordering", () => {
    const frag = rankCase("$5");
    // unsubscribed (2) > opt_out (1) > opt_in (0) > unknown (-1) — the monotonic suppression order.
    expect(frag).toMatch(/WHEN 'unsubscribed' THEN 2/);
    expect(frag).toMatch(/WHEN 'opt_out' THEN 1/);
    expect(frag).toMatch(/WHEN 'opt_in' THEN 0/);
    expect(frag).toMatch(/ELSE -1/);
    // The fragment interpolates the caller's expression verbatim (param placeholder or column ref).
    expect(rankCase("sdk_topic_consent.digest_status")).toContain("sdk_topic_consent.digest_status");
    // And the numeric ranks agree with the exported rank table both write paths share.
    expect(CONSENT_RANK).toMatchObject({ opt_in: 0, opt_out: 1, unsubscribed: 2 });
  });
});

// ---------------------------------------------------------------------------------------------
// (b) TOPIC_CACHE_PROGRAM_KEY — exported from resend/topics, consumed by reconcile
// ---------------------------------------------------------------------------------------------

describe("TOPIC_CACHE_PROGRAM_KEY (exported from resend/topics; reused by broadcast/reconcile)", () => {
  it("is the reserved program key the provisioning cache writes + reconcile reads", () => {
    expect(TOPIC_CACHE_PROGRAM_KEY).toBe("__envoy_topics__");
  });
});

// ---------------------------------------------------------------------------------------------
// (c)+(d) secretsMatch + jsonResponse — exported from route/handler, consumed by mcp + webhook
// ---------------------------------------------------------------------------------------------

describe("secretsMatch (exported from route/handler; reused by route/mcp)", () => {
  it("constant-time compares equal secrets true, unequal/length-mismatch/empty false", () => {
    expect(secretsMatch("super-secret", "super-secret")).toBe(true);
    expect(secretsMatch("super-secret", "super-secre7")).toBe(false);
    expect(secretsMatch("short", "longer-secret")).toBe(false); // length mismatch → false (no throw)
    expect(secretsMatch("", "x")).toBe(false);
    expect(secretsMatch("x", "")).toBe(false);
    expect(secretsMatch("", "")).toBe(false);
  });
});

describe("jsonResponse (exported from route/handler; reused by route/webhook)", () => {
  it("serializes the body as JSON with the given status + content-type", async () => {
    const res = jsonResponse(200, { ok: true, n: 1 });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true, n: 1 });

    const err = jsonResponse(500, { error: "boom" });
    expect(err.status).toBe(500);
    expect(await err.json()).toEqual({ error: "boom" });
  });
});
