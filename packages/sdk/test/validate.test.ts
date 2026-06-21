import { afterEach, describe, expect, it, vi } from "vitest";

import {
  validateConfig,
  validateSequences,
  validateSequenceSlots,
  assertTransactionalStream,
  assertWatermarkColumnType,
  clearValidationCache,
  ValidationError,
  type WatermarkColumnDeclaration,
} from "@sdk/validate.js";
import { defineSequence, type Sequence } from "@sdk/drip/sequence.js";
import type { ResendClientHandle } from "@sdk/resend/client.js";
import type { Envoy } from "@sdk/config.js";

// U18 — config-time validation. Two arms:
//   1. synchronous, no-network: assertTransactionalStream + assertWatermarkColumnType.
//   2. lazy, network: the slot⇄Template check via templates.get (mocked; never real network).
//
// The slot check uses the RAW `templates.get` so `variables: null` (a draft Template) survives as
// "cannot confirm" (warn) rather than being normalized to `[]` (which would read as a real miss).

// --- Resend mock --------------------------------------------------------------------------------
// A hand-rolled ResendClientHandle exposing only `templates.get` returning Resend's `{ data, error }`
// shape — including the raw `variables: null` form. Mirrors render.test.ts's fakeResend.

type RawTemplate = {
  id: string;
  html: string;
  text: string | null;
  variables: { key: string; fallback_value?: string | number | null; type?: string }[] | null;
};

function fakeResend(opts?: {
  enabled?: boolean;
  templates?: Record<string, RawTemplate>;
  templateError?: { message?: string } | null;
}): { handle: ResendClientHandle; get: ReturnType<typeof vi.fn> } {
  const enabled = opts?.enabled ?? true;
  const templates = opts?.templates ?? {};

  const get = vi.fn(async (id: string) => {
    if (opts?.templateError) return { data: null, error: opts.templateError };
    const t = templates[id];
    if (!t) return { data: null, error: { message: "template not found" } };
    return { data: t, error: null };
  });

  const fakeClient = { templates: { get } };
  const handle: ResendClientHandle = {
    enabled,
    client: () => (enabled ? (fakeClient as never) : null),
  };
  return { handle, get };
}

function tmpl(id: string, variableKeys: string[] | null): RawTemplate {
  return {
    id,
    html: "<p>{{x}}</p>",
    text: null,
    variables: variableKeys === null ? null : variableKeys.map((key) => ({ key, type: "string" })),
  };
}

afterEach(() => {
  clearValidationCache();
  vi.restoreAllMocks();
});

// =================================================================================================
// 1. Synchronous, no-network — assertTransactionalStream
// =================================================================================================

describe("assertTransactionalStream", () => {
  it("accepts a valid stream", () => {
    expect(() => assertTransactionalStream("digest")).not.toThrow();
    expect(() => assertTransactionalStream("alert")).not.toThrow();
  });

  it("rejects a missing stream (R45/R46: a send with no stream fails at config time)", () => {
    expect(() => assertTransactionalStream(undefined)).toThrow(ValidationError);
    expect(() => assertTransactionalStream(undefined)).toThrow(/must name a `stream`/);
  });

  it("rejects an empty / whitespace stream", () => {
    expect(() => assertTransactionalStream("")).toThrow(ValidationError);
    expect(() => assertTransactionalStream("   ")).toThrow(ValidationError);
  });

  it("rejects an unknown stream", () => {
    expect(() => assertTransactionalStream("marketing")).toThrow(/unknown stream "marketing"/);
  });

  it("includes the caller context in the message when provided", () => {
    expect(() => assertTransactionalStream(undefined, "send.transactional")).toThrow(
      /send\.transactional:/
    );
  });

  it("narrows the type for TS callers when it passes (asserts)", () => {
    const s: unknown = "digest";
    assertTransactionalStream(s);
    // After the assert, `s` is `Stream`; this is a compile-time guarantee, asserted at runtime above.
    expect(s).toBe("digest");
  });
});

// =================================================================================================
// 1. Synchronous, no-network — assertWatermarkColumnType
// =================================================================================================

describe("assertWatermarkColumnType", () => {
  const ok: WatermarkColumnDeclaration = { column: "created_at", type: "timestamptz", nullable: false };

  it("accepts a non-nullable timestamp/id column", () => {
    expect(() => assertWatermarkColumnType(ok)).not.toThrow();
    expect(() =>
      assertWatermarkColumnType({ column: "id", type: "bigint", nullable: false })
    ).not.toThrow();
  });

  it("REJECTS a nullable column declaration at setup (the core R45 watermark check)", () => {
    expect(() =>
      assertWatermarkColumnType({ column: "created_at", type: "timestamptz", nullable: true })
    ).toThrow(ValidationError);
    expect(() =>
      assertWatermarkColumnType({ column: "created_at", type: "timestamptz", nullable: true })
    ).toThrow(/declared NULLABLE/);
  });

  it("rejects an empty column name", () => {
    expect(() =>
      assertWatermarkColumnType({ column: "", type: "bigint", nullable: false })
    ).toThrow(/non-empty `column`/);
  });

  it("rejects an unknown column type", () => {
    expect(() =>
      assertWatermarkColumnType({
        column: "c",
        type: "jsonb" as unknown as WatermarkColumnDeclaration["type"],
        nullable: false,
      })
    ).toThrow(/unknown type "jsonb"/);
  });

  it("rejects a non-object declaration", () => {
    expect(() =>
      assertWatermarkColumnType(null as unknown as WatermarkColumnDeclaration)
    ).toThrow(/must be a \{ column, type, nullable \} object/);
  });

  it("treats a non-false nullable (truthy non-boolean) as nullable and rejects it", () => {
    expect(() =>
      assertWatermarkColumnType({
        column: "c",
        type: "text",
        nullable: 1 as unknown as boolean,
      })
    ).toThrow(/NULLABLE/);
  });
});

// =================================================================================================
// 2. Lazy, network — validateSequenceSlots
// =================================================================================================

describe("validateSequenceSlots", () => {
  function seq(steps: { templateId: string; aiSlots: string[]; brief?: string }[]): Sequence {
    return defineSequence({
      key: "welcome",
      steps: steps.map((s) => ({
        templateId: s.templateId,
        waitDays: 0,
        aiSlots: s.aiSlots,
        brief: s.aiSlots.length > 0 ? (s.brief ?? "brief") : "",
      })),
    });
  }

  it("passes when every declared slot exists on its Template", async () => {
    const { handle } = fakeResend({
      templates: { t0: tmpl("t0", ["GREETING", "CTA"]) },
    });
    const res = await validateSequenceSlots(handle, seq([{ templateId: "t0", aiSlots: ["GREETING", "CTA"] }]));
    expect(res.sequenceKey).toBe("welcome");
    expect(res.steps[0]!.missing).toEqual([]);
    expect(res.steps[0]!.warned).toBe(false);
    expect(res.warnings).toEqual([]);
  });

  it("FAILS LOUD when a declared slot is absent from a concrete Template variable list (R45)", async () => {
    const { handle } = fakeResend({
      templates: { t0: tmpl("t0", ["GREETING"]) }, // CTA is missing
    });
    await expect(
      validateSequenceSlots(handle, seq([{ templateId: "t0", aiSlots: ["GREETING", "CTA"] }]))
    ).rejects.toThrow(ValidationError);
    await expect(
      validateSequenceSlots(handle, seq([{ templateId: "t0", aiSlots: ["GREETING", "CTA"] }]))
    ).rejects.toThrow(/missing slot\(s\) \[CTA\]/);
  });

  it("treats a Template with `variables: null` as CANNOT CONFIRM → warn, not error", async () => {
    const { handle } = fakeResend({
      templates: { draft: tmpl("draft", null) },
    });
    const res = await validateSequenceSlots(handle, seq([{ templateId: "draft", aiSlots: ["GREETING"] }]));
    expect(res.steps[0]!.warned).toBe(true);
    expect(res.steps[0]!.missing).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/cannot confirm slots \[GREETING\]/);
  });

  it("distinguishes an EMPTY concrete variable list (error) from a null one (warn)", async () => {
    const { handle } = fakeResend({
      templates: { empty: tmpl("empty", []) }, // concrete, but no variables ⇒ declared slot is a real miss
    });
    await expect(
      validateSequenceSlots(handle, seq([{ templateId: "empty", aiSlots: ["GREETING"] }]))
    ).rejects.toThrow(/missing slot\(s\) \[GREETING\]/);
  });

  it("skips the Template fetch entirely for a step with no declared slots", async () => {
    const { handle, get } = fakeResend({ templates: { t0: tmpl("t0", []) } });
    const res = await validateSequenceSlots(handle, seq([{ templateId: "t0", aiSlots: [] }]));
    expect(get).not.toHaveBeenCalled();
    expect(res.steps[0]!.missing).toEqual([]);
    expect(res.steps[0]!.warned).toBe(false);
  });

  it("collects missing slots across MULTIPLE steps into one error", async () => {
    const { handle } = fakeResend({
      templates: {
        t0: tmpl("t0", ["A"]), // missing B
        t1: tmpl("t1", []), // missing C
      },
    });
    let caught: Error | undefined;
    try {
      await validateSequenceSlots(
        handle,
        seq([
          { templateId: "t0", aiSlots: ["A", "B"] },
          { templateId: "t1", aiSlots: ["C"] },
        ])
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught!.message).toMatch(/step 0 .*missing slot\(s\) \[B\]/);
    expect(caught!.message).toMatch(/step 1 .*missing slot\(s\) \[C\]/);
  });

  it("caches by Template id — two steps on the same Template fetch once", async () => {
    const { handle, get } = fakeResend({ templates: { shared: tmpl("shared", ["A"]) } });
    await validateSequenceSlots(
      handle,
      seq([
        { templateId: "shared", aiSlots: ["A"] },
        { templateId: "shared", aiSlots: ["A"] },
      ])
    );
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("fails loud when the Template is not found", async () => {
    const { handle } = fakeResend({ templates: {} });
    await expect(
      validateSequenceSlots(handle, seq([{ templateId: "ghost", aiSlots: ["A"] }]))
    ).rejects.toThrow(/templates\.get failed for "ghost"/);
  });

  it("fails loud when an upstream templates.get error is returned", async () => {
    const { handle } = fakeResend({ templateError: { message: "rate limited" } });
    await expect(
      validateSequenceSlots(handle, seq([{ templateId: "t0", aiSlots: ["A"] }]))
    ).rejects.toThrow(/rate limited/);
  });

  it("is a network check that requires Resend — unset key throws (only on a slot-bearing step)", async () => {
    const { handle, get } = fakeResend({ enabled: false });
    await expect(
      validateSequenceSlots(handle, seq([{ templateId: "t0", aiSlots: ["A"] }]))
    ).rejects.toThrow(/Resend is not configured/);
    expect(get).not.toHaveBeenCalled();
  });

  it("does NOT touch Resend for a slot-free sequence even when the key is unset (no-op preserved)", async () => {
    const { handle, get } = fakeResend({ enabled: false });
    const res = await validateSequenceSlots(handle, seq([{ templateId: "t0", aiSlots: [] }]));
    expect(get).not.toHaveBeenCalled();
    expect(res.warnings).toEqual([]);
  });

  it("refresh:true forces a re-fetch past the cache", async () => {
    const { handle, get } = fakeResend({ templates: { t0: tmpl("t0", ["A"]) } });
    await validateSequenceSlots(handle, seq([{ templateId: "t0", aiSlots: ["A"] }]));
    await validateSequenceSlots(handle, seq([{ templateId: "t0", aiSlots: ["A"] }]), { refresh: true });
    expect(get).toHaveBeenCalledTimes(2);
  });
});

// =================================================================================================
// validateSequences (multi) + validateConfig (full entry point)
// =================================================================================================

describe("validateSequences", () => {
  function oneStep(key: string, templateId: string, aiSlots: string[]): Sequence {
    return defineSequence({
      key,
      steps: [{ templateId, waitDays: 0, aiSlots, brief: aiSlots.length ? "b" : "" }],
    });
  }

  it("shares the Template cache across sequences (a shared Template is fetched once)", async () => {
    const { handle, get } = fakeResend({ templates: { shared: tmpl("shared", ["A"]) } });
    await validateSequences(handle, [
      oneStep("s1", "shared", ["A"]),
      oneStep("s2", "shared", ["A"]),
    ]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("accumulates warnings across sequences", async () => {
    const { handle } = fakeResend({ templates: { d1: tmpl("d1", null), d2: tmpl("d2", null) } });
    const res = await validateSequences(handle, [
      oneStep("s1", "d1", ["A"]),
      oneStep("s2", "d2", ["B"]),
    ]);
    expect(res.warnings).toHaveLength(2);
  });

  it("throws on the first sequence with a real missing slot", async () => {
    const { handle } = fakeResend({ templates: { good: tmpl("good", ["A"]), bad: tmpl("bad", []) } });
    await expect(
      validateSequences(handle, [oneStep("s1", "good", ["A"]), oneStep("s2", "bad", ["Z"])])
    ).rejects.toThrow(/sequence "s2"/);
  });
});

describe("validateConfig (envoy.validate entry point)", () => {
  function fakeEnvoy(handle: ResendClientHandle): Envoy {
    return { resend: handle } as unknown as Envoy;
  }

  function oneStep(key: string, templateId: string, aiSlots: string[]): Sequence {
    return defineSequence({
      key,
      steps: [{ templateId, waitDays: 0, aiSlots, brief: aiSlots.length ? "b" : "" }],
    });
  }

  it("runs the synchronous watermark check FIRST — fails before any Resend round-trip", async () => {
    const { handle, get } = fakeResend({ templates: { t0: tmpl("t0", ["A"]) } });
    await expect(
      validateConfig(fakeEnvoy(handle), {
        sequences: [oneStep("s1", "t0", ["A"])],
        watermarks: [{ column: "created_at", type: "timestamptz", nullable: true }],
      })
    ).rejects.toThrow(/declared NULLABLE/);
    // The nullable-column check short-circuits before the network slot check runs.
    expect(get).not.toHaveBeenCalled();
  });

  it("passes when watermarks are non-nullable and all slots resolve, surfacing warnings", async () => {
    const { handle } = fakeResend({
      templates: { t0: tmpl("t0", ["A"]), draft: tmpl("draft", null) },
    });
    const res = await validateConfig(fakeEnvoy(handle), {
      sequences: [oneStep("s1", "t0", ["A"]), oneStep("s2", "draft", ["B"])],
      watermarks: [{ column: "id", type: "bigint", nullable: false }],
    });
    expect(res.sequences).toHaveLength(2);
    expect(res.warnings).toHaveLength(1); // the draft Template
  });

  it("fails loud on a missing slot from validateConfig", async () => {
    const { handle } = fakeResend({ templates: { t0: tmpl("t0", []) } });
    await expect(
      validateConfig(fakeEnvoy(handle), { sequences: [oneStep("s1", "t0", ["A"])] })
    ).rejects.toThrow(ValidationError);
  });

  it("is a no-op with no sequences or watermarks (does not touch Resend)", async () => {
    const { handle, get } = fakeResend({ enabled: false });
    const res = await validateConfig(fakeEnvoy(handle), {});
    expect(get).not.toHaveBeenCalled();
    expect(res.sequences).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it("rejects a non-object input", async () => {
    const { handle } = fakeResend();
    await expect(
      validateConfig(fakeEnvoy(handle), null as unknown as Parameters<typeof validateConfig>[1])
    ).rejects.toThrow(/requires an input object/);
  });
});
