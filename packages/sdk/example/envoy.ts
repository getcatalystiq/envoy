// Example host wiring for @envoy/sdk (U19 — internal dogfood, NOT published).
//
// This is the single place the example assembles the SDK: it builds the root
// `Envoy` handle from env, defines ONE drip sequence and ONE broadcast program,
// and exposes a small registry the cron route uses. The real app does not import
// this — it lives only under packages/sdk/example/ and is run by the authors
// against a real Resend test account to exercise the compliance-critical
// primitives end-to-end (consent mirror, send-once claim, unsubscribe).
//
// Everything imports from the package's public entry (`@envoy/sdk`) — exactly the
// surface an external host gets. No `@sdk/*` internal alias, no app `@/` import.

import { Pool } from "pg";

import {
  createEnvoy,
  createConsentMirror,
  defineSequence,
  defineBroadcastProgram,
  type Envoy,
  type Sequence,
  type BroadcastProgram,
  type ConsentMirror,
  type RenderContext,
  type RenderedIssue,
} from "@envoy/sdk";

// ---------------------------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `[example] missing required env ${name} — see packages/sdk/example/README.md`,
    );
  }
  return value;
}

// Absolute https base the List-Unsubscribe header + landing point at. In the example
// this is the host app's own origin; the SDK mounts /api/envoy/unsubscribe under it.
const UNSUBSCRIBE_BASE_URL = `${requireEnv("EXAMPLE_BASE_URL")}/api/envoy/unsubscribe`;

// ---------------------------------------------------------------------------------------------
// The root handle (lazy Resend client; no network at construction)
// ---------------------------------------------------------------------------------------------

// One shared pg Pool for the whole example. The SDK never opens its own connection —
// the host owns the database (BYO Postgres).
const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });

export const envoy: Envoy = createEnvoy({
  db: pool,
  installNamespace: "example",
  resendApiKey: process.env.RESEND_API_KEY,
  webhookSecret: requireEnv("RESEND_WEBHOOK_SECRET"),
  cronSecret: requireEnv("CRON_SECRET"),
  unsubscribeSecret: requireEnv("ENVOY_UNSUBSCRIBE_SECRET"),
  baseSegmentId: requireEnv("RESEND_BASE_SEGMENT_ID"),
  // Only fields on this allow-list are ever projected into the AI personalization payload (R44).
  aiFieldAllowList: ["firstName", "company", "plan"],
  // Per-stream From defaults. The drip lane sends on `digest`; the broadcast program too.
  streams: {
    digest: { from: requireEnv("EXAMPLE_FROM_DIGEST") },
    alert: { from: process.env.EXAMPLE_FROM_ALERT },
  },
  // Drip lane only — the broadcast lane forwards nothing to Anthropic.
  agent:
    process.env.ENVOY_AGENT_ID && process.env.ENVOY_AGENT_ENVIRONMENT_ID
      ? {
          agentId: process.env.ENVOY_AGENT_ID,
          environmentId: process.env.ENVOY_AGENT_ENVIRONMENT_ID,
        }
      : undefined,
});

// The consent mirror is the send gate the drip cron checks before every step.
export const mirror: ConsentMirror = createConsentMirror(envoy.db, envoy.resend);

export { UNSUBSCRIBE_BASE_URL };

// ---------------------------------------------------------------------------------------------
// One drip sequence — the differentiated AI-per-recipient lane (the wedge)
// ---------------------------------------------------------------------------------------------

// A two-step welcome drip. Step 0 fires immediately on enroll; step 1 three days later.
// Each step names a saved Resend Template and the variables the agent fills per recipient.
export const WELCOME_SEQUENCE_KEY = "welcome";

export const welcomeSequence: Sequence = defineSequence({
  key: WELCOME_SEQUENCE_KEY,
  steps: [
    {
      templateId: requireEnv("EXAMPLE_TEMPLATE_WELCOME_1"),
      waitDays: 0,
      aiSlots: ["intro_line"],
      brief:
        "Write a single warm opening line that references the recipient's company and plan. " +
        "One sentence, no greeting, no signature.",
    },
    {
      templateId: requireEnv("EXAMPLE_TEMPLATE_WELCOME_2"),
      waitDays: 3,
      aiSlots: ["nudge_line"],
      brief:
        "Write a short, friendly follow-up nudge inviting the recipient to try one core feature. " +
        "Two sentences max, reference their firstName if present.",
    },
  ],
});

// The registry the drip cron resolves enrollments against. Sequence definitions live in
// host code (never the DB) — an enrollment whose key is unregistered is skipped, not dropped.
export const sequenceRegistry: ReadonlyMap<string, Sequence> = new Map([
  [welcomeSequence.key, welcomeSequence],
]);

// ---------------------------------------------------------------------------------------------
// One broadcast program — the Resend-native newsletter lane
// ---------------------------------------------------------------------------------------------

// A weekly digest. `render` owns the content decision (which Template, which variables,
// the subject line, and the new high-water mark). Returning `null` is the explicit skip
// signal when the host query found nothing new.
export const DIGEST_PROGRAM_KEY = "weekly-digest";

export const digestProgram: BroadcastProgram = defineBroadcastProgram({
  key: DIGEST_PROGRAM_KEY,
  segmentId: requireEnv("RESEND_BASE_SEGMENT_ID"),
  cadenceDays: 7,
  from: process.env.EXAMPLE_FROM_DIGEST,
  // Single-stream newsletter: every subject is a `digest` Topic keyed by the subject.
  topicKeyFor: (subjectKey) => ({ stream: "digest", subject: subjectKey }),
  render: (ctx: RenderContext): RenderedIssue | null => {
    // The host decides what is "new" since the last issue and hands it in as `items`.
    // An empty batch ⇒ skip (no send, no advance).
    if (ctx.items.length === 0) return null;

    // The newest item's ordering value becomes the new watermark (strictly-greater on advance).
    const items = ctx.items as ReadonlyArray<{ id: string; publishedAt: string; title: string }>;
    const newest = items[items.length - 1]!;

    return {
      templateId: requireEnv("EXAMPLE_TEMPLATE_DIGEST"),
      subject: `This week: ${newest.title}`,
      variables: {
        issue_count: String(items.length),
        lead_title: newest.title,
      },
      watermark: newest.publishedAt,
      itemIds: items.map((i) => i.id),
    };
  },
});

export const programRegistry: ReadonlyMap<string, BroadcastProgram> = new Map([
  [digestProgram.key, digestProgram],
]);
