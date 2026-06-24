import { beforeEach, describe, expect, it, vi } from "vitest";

import { saveSequence, deleteSequence, getSequence, listSequences } from "@sdk/drip/crud.js";
import { SequenceDefinitionError, type DefineSequenceInput } from "@sdk/drip/sequence.js";
import { ValidationError, clearValidationCache } from "@sdk/validate.js";
import { createDb, type SdkPool, type SdkQueryResult } from "@sdk/db/pool.js";
import type { ResendClientHandle } from "@sdk/resend/client.js";
import type { Envoy } from "@sdk/config.js";

// U-S3 — validated CRUD: defineSequence (shape) + validateSequenceSlots (network) BEFORE persist.

type RawTemplate = { id: string; html: string; text: string | null; variables: { key: string }[] | null };
function tmpl(id: string, variableKeys: string[] | null): RawTemplate {
  return { id, html: "", text: null, variables: variableKeys === null ? null : variableKeys.map((key) => ({ key })) };
}

function fakeResend(templates: Record<string, RawTemplate>, enabled = true): {
  handle: ResendClientHandle;
  get: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(async (id: string) => {
    const t = templates[id];
    return t ? { data: t, error: null } : { data: null, error: { message: "not found" } };
  });
  const handle: ResendClientHandle = { enabled, client: () => (enabled ? ({ templates: { get } } as never) : null) };
  return { handle, get };
}

/** Fake pool over sdk_sequence_defs (upsert/history/read/list). */
function fakePool(): SdkPool {
  const defs = new Map<string, { steps: string; version: number }>();
  const k = (ns: string, key: string) => `${ns}|${key}`;
  return {
    async query<T = Record<string, unknown>>(text: string, params: ReadonlyArray<unknown> = []): Promise<SdkQueryResult<T>> {
      const sql = text.replace(/\s+/g, " ").trim();
      const p = params as unknown[];
      if (sql.startsWith("WITH up AS")) {
        const [ns, key, steps] = p as [string, string, string];
        const prev = defs.get(k(ns, key));
        const version = prev ? prev.version + 1 : 1;
        defs.set(k(ns, key), { steps, version });
        return { rows: [{ version }] as T[] };
      }
      if (sql.startsWith("SELECT steps, agent_config FROM sdk_sequence_defs")) {
        const [ns, key] = p as [string, string];
        const row = defs.get(k(ns, key));
        return { rows: row ? ([{ steps: row.steps }] as T[]) : [] };
      }
      if (sql.startsWith("DELETE FROM sdk_sequence_defs")) {
        const [ns, key] = p as [string, string];
        return { rows: defs.delete(k(ns, key)) ? ([{ id: 1 }] as T[]) : [] };
      }
      if (sql.startsWith("SELECT sequence_key, version, updated_at FROM sdk_sequence_defs")) {
        const [ns] = p as [string];
        const prefix = `${ns}|`;
        return {
          rows: [...defs.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, v]) => ({ sequence_key: key.slice(prefix.length), version: v.version, updated_at: "t" })) as T[],
        };
      }
      throw new Error(`fakePool: unhandled SQL: ${sql}`);
    },
  };
}

function envoyWith(resend: ResendClientHandle, pool = fakePool()): Envoy {
  return { db: createDb(pool, "prod"), resend } as unknown as Envoy;
}

const INPUT: DefineSequenceInput = {
  key: "onboarding",
  steps: [
    { templateId: "tmpl-welcome", waitDays: 0, aiSlots: ["WELCOME_BODY"], brief: "welcome" },
    { templateId: "tmpl-edu", waitDays: 5, aiSlots: ["EDU_BODY"], brief: "educate" },
  ],
};

describe("validated sequence CRUD (U-S3)", () => {
  beforeEach(() => clearValidationCache());

  it("persists a valid def whose aiSlots exist on their templates (version 1, no warnings)", async () => {
    const { handle } = fakeResend({
      "tmpl-welcome": tmpl("tmpl-welcome", ["WELCOME_BODY"]),
      "tmpl-edu": tmpl("tmpl-edu", ["EDU_BODY"]),
    });
    const envoy = envoyWith(handle);
    const res = await saveSequence(envoy, INPUT, { actor: "user-1" });
    expect(res.version).toBe(1);
    expect(res.warnings).toEqual([]);
    expect((await getSequence(envoy, "onboarding"))?.steps).toHaveLength(2);
    expect((await listSequences(envoy)).map((r) => r.key)).toEqual(["onboarding"]);
  });

  it("rejects (ValidationError) when an aiSlot is absent on its template — and persists NOTHING", async () => {
    const { handle } = fakeResend({
      "tmpl-welcome": tmpl("tmpl-welcome", ["WELCOME_BODY"]),
      "tmpl-edu": tmpl("tmpl-edu", []), // EDU_BODY missing
    });
    const envoy = envoyWith(handle);
    await expect(saveSequence(envoy, INPUT)).rejects.toBeInstanceOf(ValidationError);
    expect(await getSequence(envoy, "onboarding")).toBeUndefined();
  });

  it("rejects a bad shape (empty steps) via SequenceDefinitionError BEFORE any network call", async () => {
    const { handle, get } = fakeResend({});
    const envoy = envoyWith(handle);
    await expect(saveSequence(envoy, { key: "x", steps: [] })).rejects.toBeInstanceOf(SequenceDefinitionError);
    expect(get).not.toHaveBeenCalled();
  });

  it("persists with a warning when a template is a draft (variables:null) — validation deferred", async () => {
    const { handle } = fakeResend({
      "tmpl-welcome": tmpl("tmpl-welcome", null), // draft → can't confirm
      "tmpl-edu": tmpl("tmpl-edu", ["EDU_BODY"]),
    });
    const envoy = envoyWith(handle);
    const res = await saveSequence(envoy, INPUT);
    expect(res.version).toBe(1);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(await getSequence(envoy, "onboarding")).toBeDefined();
  });

  it("re-save after publishing a draft template clears the deferred warning (refresh:true)", async () => {
    const templates: Record<string, RawTemplate> = {
      "tmpl-welcome": tmpl("tmpl-welcome", null), // draft → can't confirm
      "tmpl-edu": tmpl("tmpl-edu", ["EDU_BODY"]),
    };
    const { handle } = fakeResend(templates);
    const envoy = envoyWith(handle);
    expect((await saveSequence(envoy, INPUT)).warnings.length).toBeGreaterThan(0); // draft → deferred
    templates["tmpl-welcome"] = tmpl("tmpl-welcome", ["WELCOME_BODY"]); // publish the template
    expect((await saveSequence(envoy, INPUT)).warnings).toEqual([]); // refresh:true re-fetches → warning gone
  });

  it("re-save increments version; delete removes the row", async () => {
    const { handle } = fakeResend({
      "tmpl-welcome": tmpl("tmpl-welcome", ["WELCOME_BODY"]),
      "tmpl-edu": tmpl("tmpl-edu", ["EDU_BODY"]),
    });
    const envoy = envoyWith(handle);
    expect((await saveSequence(envoy, INPUT)).version).toBe(1);
    expect((await saveSequence(envoy, INPUT)).version).toBe(2);
    expect(await deleteSequence(envoy, "onboarding")).toBe(true);
    expect(await deleteSequence(envoy, "onboarding")).toBe(false);
    expect(await getSequence(envoy, "onboarding")).toBeUndefined();
  });
});
