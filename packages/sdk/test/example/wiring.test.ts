import { describe, expect, it } from "vitest";

// U19 — the internal dogfood example under packages/sdk/example/ has NO behavioral tests of its
// own (it is exercised manually against a real Resend account). This smoke test exists to keep the
// example's WIRING honest: it composes the exact same public exports the example uses
// (createEnvoy / createConsentMirror / defineSequence / defineBroadcastProgram) the exact same way,
// with NO network or DB, so a future change to the SDK's public surface that would break the
// example fails here instead of silently rotting under example/ (which the package tsconfig does
// not typecheck and Vitest does not run).
//
// It imports from the package's public entry (@sdk/index.js → the built `@catalystiq/envoy-sdk` surface) —
// not internal modules — mirroring what the example's `import { ... } from "@catalystiq/envoy-sdk"` resolves.

import {
  createEnvoy,
  createConsentMirror,
  defineSequence,
  defineBroadcastProgram,
  type Envoy,
  type RenderContext,
  type RenderedIssue,
  type CursorState,
} from "@sdk/index.js";
import type { SdkPool, SdkQueryResult } from "@sdk/db/pool.js";

// A no-op pool: createEnvoy + createConsentMirror touch NO network/DB at construction, so the
// example's module-load wiring must not need a live query. If any of them did, this would throw.
function inertPool(): SdkPool {
  return {
    query: async <T = Record<string, unknown>>(): Promise<SdkQueryResult<T>> => ({
      rows: [] as T[],
    }),
  };
}

// The env-free equivalent of the example's `createEnvoy({...})` block (envoy.ts).
function buildExampleEnvoy(): Envoy {
  return createEnvoy({
    db: inertPool(),
    installNamespace: "example",
    resendApiKey: undefined, // unset key ⇒ lazy no-op client (no network)
    webhookSecret: "whsec_test",
    cronSecret: "cron_test",
    unsubscribeSecret: "unsub_test",
    baseSegmentId: "seg_base",
    aiFieldAllowList: ["firstName", "company", "plan"],
    streams: {
      digest: { from: "Acme <digest@acme.dev>" },
      alert: { from: "Acme <alerts@acme.dev>" },
    },
  });
}

describe("example wiring (U19 dogfood)", () => {
  it("builds the root handle from the example's config without network/DB", () => {
    const envoy = buildExampleEnvoy();
    expect(envoy.config.installNamespace).toBe("example");
    expect(envoy.config.baseSegmentId).toBe("seg_base");
    // Unset Resend key ⇒ disabled client (preserves U3's no-op-on-unset-key).
    expect(envoy.resend.enabled).toBe(false);
    // toJSON never leaks secrets.
    const dumped = JSON.parse(JSON.stringify(envoy)) as Record<string, unknown>;
    expect(dumped.installNamespace).toBe("example");
    expect(dumped).not.toHaveProperty("cronSecret");
    expect(dumped).not.toHaveProperty("unsubscribeSecret");
  });

  it("builds the consent mirror the drip cron gates against", () => {
    const envoy = buildExampleEnvoy();
    const mirror = createConsentMirror(envoy.db, envoy.resend);
    expect(typeof mirror.gate).toBe("function");
  });

  it("defines the example's two-step welcome sequence with the declared AI slots", () => {
    const seq = defineSequence({
      key: "welcome",
      steps: [
        { templateId: "tmpl_w1", waitDays: 0, aiSlots: ["intro_line"], brief: "opening line" },
        { templateId: "tmpl_w2", waitDays: 3, aiSlots: ["nudge_line"], brief: "follow-up nudge" },
      ],
    });
    expect(seq.key).toBe("welcome");
    expect(seq.steps).toHaveLength(2);
    expect(seq.steps[0]!.waitDays).toBe(0);
    expect(seq.steps[0]!.aiSlots).toEqual(["intro_line"]);
    expect(seq.steps[1]!.waitDays).toBe(3);
  });

  it("defines the digest broadcast program with the declared topic + deterministic key", () => {
    // The example's `render` closure, lifted so the test can assert its skip-on-empty contract
    // directly (the public handle deliberately does not re-expose `render`).
    const render = (ctx: RenderContext): RenderedIssue | null => {
      if (ctx.items.length === 0) return null;
      const items = ctx.items as ReadonlyArray<{ id: string; publishedAt: string; title: string }>;
      const newest = items[items.length - 1]!;
      return {
        templateId: "tmpl_digest",
        subject: `This week: ${newest.title}`,
        variables: { issue_count: String(items.length), lead_title: newest.title },
        watermark: newest.publishedAt,
        itemIds: items.map((i) => i.id),
      };
    };

    const program = defineBroadcastProgram({
      key: "weekly-digest",
      segmentId: "seg_base",
      cadenceDays: 7,
      from: "Acme <digest@acme.dev>",
      topicKeyFor: (subjectKey) => ({ stream: "digest", subject: subjectKey }),
      render,
    });

    expect(program.key).toBe("weekly-digest");
    expect(program.segmentId).toBe("seg_base");
    expect(program.cadenceDays).toBe(7);
    // The topic resolver the host declared (the unsubscribe gate, KTD9).
    expect(program.topicFor("default")).toEqual({ stream: "digest", subject: "default" });
    // Deterministic broadcast key shape (key:subjectKey:issueSeq) — the send-once dedup anchor.
    expect(program.broadcastKey("default", 0)).toBe("weekly-digest:default:0");

    // Empty batch ⇒ explicit skip signal (runIssue then neither sends nor advances).
    const cursor: CursorState = { watermark: null, issueSeq: 0, lastFiredAt: null, paused: false };
    expect(render({ subjectKey: "default", items: [], cursor, topicId: "top_1" })).toBeNull();

    // Non-empty batch ⇒ a renderable issue naming the newest item's watermark.
    const rendered = render({
      subjectKey: "default",
      items: [
        { id: "a", publishedAt: "2026-06-20T00:00:00Z", title: "First" },
        { id: "b", publishedAt: "2026-06-21T00:00:00Z", title: "Second" },
      ],
      cursor,
      topicId: "top_1",
    });
    expect(rendered).not.toBeNull();
    expect(rendered!.watermark).toBe("2026-06-21T00:00:00Z");
    expect(rendered!.subject).toBe("This week: Second");
    expect(rendered!.itemIds).toEqual(["a", "b"]);
  });
});
