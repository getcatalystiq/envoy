# Envoy SDK — Agent Integration Guide

> **Audience: an AI coding agent integrating `@catalystiq/envoy-sdk` into a host Next.js (App Router) app.**
> Copy the relevant parts into the host repo's `AGENTS.md`/`CLAUDE.md`, or follow this top-to-bottom. Every step below maps to a requirement (`Rnn`) in `docs/brainstorms/2026-06-21-envoy-resend-sdk-rearchitecture-requirements.md` — read that doc for the *why*; this guide is the *how*.
>
> Envoy is **headless, single-tenant, bring-your-own-Postgres**. It owns the dangerous email mechanics (claim/resume, consent reconcile, segment sync, render+dispatch); the **host owns auth, UI, the clock, the content query, and the eligibility predicate**. Do not re-implement what the SDK provides — wire to it.

---

## 0. Preconditions (verify before writing code)

- [ ] Host is **Next.js App Router**.
- [ ] Host has a **Postgres** the SDK can run migrations against (Neon/Supabase/etc).
- [ ] Host has a **Resend account + API key**, on **`resend@^6.14.0`** (`npm ls resend`).
- [ ] Host has an **Anthropic** key + a configured Claude Managed Agent id + environment id (only needed for the AI **drip** lane).
- [ ] Host already owns **auth** (you will pass an `authorize(req)` callback; Envoy ships no login).

**Hard Resend facts to respect (do not fight these):**
- `broadcasts.create` accepts `react | html | text` only — **no `templateId`**, **no `headers`**, **no idempotency key**.
- `emails.send` accepts `template:{id,variables}` **and** an idempotency key **and** custom `headers`.
- `templates.get(id)` returns the template's `html`/`text` + variables (so you can fetch + fill in code).
- Contact model is global **Contacts** + static **Segments** (no rule engine) + **Topics** (`opt_in`/`opt_out`). `audiences` is deprecated — never use it.
- The `contact.updated` webhook carries only a global `unsubscribed` flag + `segment_ids` — **no `topic_id`**, and there are **no `topic.*` events**.

---

## 1. Install + migrate

```bash
npm i @catalystiq/envoy-sdk resend
```

`@catalystiq/envoy-sdk` is **published on npm** — install it like any other dependency.

**Migrate.** There is **no `envoy` CLI** (`npx envoy migrate` does not exist). Apply Envoy's tables to your `DATABASE_URL` one of two ways:

- Call the programmatic `migrate(pool)` from a **server** context (a route / server action / deploy step). It can NOT run from a plain node script — the SDK imports `server-only`, which throws outside a Next/RSC bundler.
- Or apply the shipped SQL directly from a node script: the package exports it at `@catalystiq/envoy-sdk/migrations/*.sql`. Every file is `CREATE … IF NOT EXISTS`, so applying each file whole (one multi-statement query) is idempotent and re-runnable — no SDK import, no `server-only` guard.

Envoy owns a bounded set of tables (contact mirror, per-topic consent, cursor/watermark, broadcast claim rows). They are **namespace-scoped** (R38) — see §3.

---

## 2. Configure secrets (R43)

Set these as environment secrets (never commit, never log):

| Env var | Purpose | Required |
|---|---|---|
| `DATABASE_URL` | Envoy's Postgres | yes |
| `RESEND_API_KEY` | Resend transport | yes |
| `RESEND_WEBHOOK_SECRET` | Svix webhook verify (R41) | yes |
| `CRON_SECRET` | cron sub-path auth (R40) | yes (prod) |
| `ENVOY_UNSUBSCRIBE_SECRET` | signs unsubscribe tokens (R33) — **independent of any auth secret** | yes |
| `ANTHROPIC_API_KEY` + agent id + environment id | drip-lane AI (R23/R24) | drip lane only |

**DON'T** read `process.env` inside the SDK yourself; **DO** pass values into `createEnvoy` (R43).

---

## 3. Create the Envoy instance (once, server-only)

```ts
// lib/envoy.ts  — server-only
import "server-only";
import { createEnvoy } from "@catalystiq/envoy-sdk";
import { pool } from "@/lib/db";

export const envoy = createEnvoy({
  db: pool,
  installNamespace: "myapp-prod",        // R38: one namespace = one tenant. staging/prod = two namespaces.
  resendApiKey: process.env.RESEND_API_KEY!,
  webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,
  cronSecret: process.env.CRON_SECRET!,
  unsubscribeSecret: process.env.ENVOY_UNSUBSCRIBE_SECRET!,
  // Absolute https unsubscribe landing URL. Required to use `envoy.send.transactional` on the
  // STANDARD lane (the List-Unsubscribe header points here); system-lane sends don't need it.
  unsubscribeBaseUrl: "https://www.myapp.com/api/envoy/unsubscribe",
  baseSegmentId: process.env.RESEND_BASE_SEGMENT_ID!,   // provision once; cache the id
  agent: { agentId: process.env.ANTHROPIC_AGENT_ID, environmentId: process.env.ANTHROPIC_ENV_ID }, // drip only
  // Per-stream config carries a default From only. Consent defaults are SDK behavior (topics are
  // opt_in by default; per-topic opt-out is a user action) — NOT configured here.
  streams: { digest: { from: "Acme <news@acme.com>" }, alert: { from: "Acme <alerts@acme.com>" } },
  // R44: only these contact fields are forwarded to the AI agent — never the whole `data` blob
  aiFieldAllowList: ["firstName", "plan", "country"],
  // KTD7: Template ids allowed on the non-gated `system` transactional lane (receipts). A
  // `system: true` send whose templateId is NOT listed here throws SystemLaneViolation.
  systemTemplateIds: ["tmpl_booking_confirmation", "tmpl_receipt"],
});
```

> **Capability gate.** `import { SDK_VERSION, getCapabilities } from "@catalystiq/envoy-sdk"` — `SDK_VERSION` is build-derived from `package.json` (never a stale constant) and `getCapabilities()` returns `{ attachments, systemLane }`. A host running a no-fallback cutover should assert both in CI against the pinned version before merging, so it can't ship against an SDK missing the enhancements it depends on.

> **Single-tenant invariant (R7/R38):** never co-tenant multiple end customers in one installation. There is no `organization_id` row isolation — a host `authorize()` bug exposes the whole mirror. If you run multiple tenants, run multiple installs (separate namespaces, ideally separate databases).

---

## 4. Mount the route handler (R2, R6)

```ts
// app/api/envoy/[...envoy]/route.ts
import { envoy } from "@/lib/envoy";
import { getSession } from "@/lib/auth";

const handler = envoy.routeHandler({
  // R6: host owns auth. Return true/false for the API + read endpoints.
  authorize: async (req) => {
    const session = await getSession(req);
    return Boolean(session?.user?.isAdmin);
  },
});
export const GET = handler;
export const POST = handler;
```

**Per-sub-path auth is NOT uniform** (R6). The handler enforces, independently of `authorize`:
- **cron** sub-path → `CRON_SECRET` constant-time check (R40). Bypasses `authorize` (Vercel Cron can't send your session).
- **webhook** sub-path → Resend **Svix** signature verify (R41). Bypasses `authorize`.
- **unsubscribe** landing → signed token (R33). Bypasses `authorize` (recipients aren't logged in).
- **MCP** sub-path → its own credential (R42). Treat as an admin API; never leave open.

Do **not** wrap these in your own `authorize` — the SDK owns their auth. Just confirm the secrets are set.

---

## 5. Drip lane (AI-personalized sequences)

### 5a. Enroll from your app events (R8–R11)

```ts
await envoy.enroll({ email, data: { firstName, plan } }, "onboarding");
// idempotent (R11): re-enrolling an active contact is a no-op, sends nothing new.
```

### 5b. Define a sequence (R12–R16). Each step references a **Resend Template by id** + declares AI slots.

```ts
envoy.defineSequence({
  key: "onboarding",
  steps: [
    { templateId: "tmpl_welcome", waitDays: 0, aiSlots: ["subject", "body"], brief: "Warm welcome, reference their plan." },
    { templateId: "tmpl_tip",     waitDays: 3, aiSlots: ["subject", "preheader", "body"], brief: "One activation tip." },
  ],
});
```

> The referenced Template **must expose** the declared slots as variables. The SDK validates this at config time (R45) — a mismatch fails loud, not at send time.

### 5c. Wire the drip cron (R20). One Vercel Cron → the mounted route.

```json
// vercel.json
{ "crons": [{ "path": "/api/envoy/cron/drip", "schedule": "*/15 * * * *" }] }
```

The SDK finds due steps, generates the AI subject/body **just-in-time** (R14), injects into the Template via `emails.send`, and advances state. Generation/send failure is retried, never sent empty (R16).

### 5d. One-shot transactional send (welcome / receipt / confirmation — non-AI, R46)

For a single templated email that is **not** an AI sequence (e.g. the welcome email on follow), use the transactional primitive — don't model it as a one-step sequence and don't call `resend.emails.send` directly:

```ts
await envoy.send.transactional({
  email,
  templateId: "tmpl_welcome",
  variables: { firstName, country },
  stream: "alert",                 // gated against the suppression mirror for this stream
  idempotencyKey: `welcome:${userId}:${country}`, // Resend emails.send idempotency → exactly-once
});
```

It consults the suppression mirror first, sets the `List-Unsubscribe` one-click headers (R33), and forwards Resend's idempotency key.

**Attachments (e.g. a booking `.ics`).** Pass `attachments: [{ filename, content, contentType? }]` — forwarded to Resend's `emails.send` (max 40 MB/email). Works on either lane.

**The `system` lane (legitimate-interest receipts).** A *paid* receipt (booking confirmation) must survive a marketing opt-out but must NOT survive a global unsubscribe / bounce / complaint / GDPR delete. Set `system: true`:

```ts
await envoy.send.transactional({
  email,
  templateId: "tmpl_booking_confirmation",
  variables: { serviceName, whenLabel },
  system: true,                       // skip per-topic/stream consent + List-Unsubscribe…
  from: "receipts@yourapp.com",       // …but a system send has no stream default, so pass `from`
  attachments: [{ filename: "invite.ics", content: icsBody, contentType: "text/calendar" }],
  idempotencyKey: `booking-confirm:${bookingId}`,
});
```

A `system` send: (1) **skips** the per-topic/stream consent gate and the `List-Unsubscribe` header (a marketing opt-out can't drop a receipt), (2) **still honors** the global hard-suppression floor — a globally-unsubscribed / bounced / complained / GDPR-deleted contact is never mailed, and (3) **requires** its `templateId` to be in `createEnvoy`'s `systemTemplateIds` allow-list, or it throws `SystemLaneViolation` (so marketing copy can't ride the lane). `stream`/`topicKey` are optional on this lane (`stream`, if given, only supplies the From default).

---

## 6. Broadcast lane (bulk, merge-vars, no AI)

> Use this **only if** you run recurring content blasts and want them to share Envoy's consent mirror. If you only want an occasional blast and run no drips, call `resend.broadcasts.create` directly — the SDK adds no value there.

### 6a. Declare a program (R35). The program fans into N **subjects** (e.g. one per country).

```ts
const program = envoy.defineBroadcastProgram({
  key: "country-digest",
  segmentId: process.env.RESEND_BASE_SEGMENT_ID!,
  topicKeyFor: (subjectKey) => `digest:${subjectKey}`, // one Topic per (type, subject), opt_in, PUBLIC (R27)
  // Break Topics up by type-of-email AND subject so the Resend preference page lets a
  // recipient drop "Italy digest" while keeping "France digest" and "law alerts".
  // Topics MUST be public to appear on the hosted unsubscribe preference page.
  cadenceDays: 14,
  render: ({ items, subjectKey }) => buildDigestHtml(items, subjectKey), // returns { html, text }
});
```

### 6b. Run it from **your own** cron (R35 — separate from the drip cron). You own the clock/content/eligibility.

```ts
// app/api/cron/newsletter/route.ts  (host-owned; the SDK does not schedule broadcasts)
for (const subjectKey of getLaunchedCountries()) {
  const cur = await program.cursor.read(subjectKey);
  if (!program.cursor.due(cur, { cadenceDays: 14 })) continue;        // N-day timer (R36)
  const items = await db.activeContentSince(subjectKey, cur.watermark); // YOUR query (host owns it)
  if (!items.length) continue;                                         // only-if-new (no advance)
  if (await program.eligibleCount(subjectKey) === 0) continue;         // skip-zero (no advance)
  await program.runIssue({ subjectKey, items });  // reconcile → claim/resume → render → send → advance (R35)
}
```

```json
// vercel.json  (add alongside the drip cron)
{ "crons": [
  { "path": "/api/envoy/cron/drip", "schedule": "*/15 * * * *" },
  { "path": "/api/cron/newsletter", "schedule": "0 12 * * *" }
] }
```

> **Host responsibilities the SDK cannot validate at runtime:** the content query orders by a **non-null** column (`created_at`, NOT a nullable `published_date`) — strictly-greater watermark compare avoids re-send/drop. `runIssue` is per-subject fail-soft (one subject's Resend error won't abort your loop).

### 6c. Broadcast templates (R18, R32)

The shell is a **Resend Template** (single source of truth). The SDK fetches it via `templates.get`, fills the variables **in code** (Resend does not substitute template variables on the broadcast path), and pushes `{ html, text }` to `broadcasts.create({ send: true })`. Leave per-recipient values as Resend **merge tags** (`{{{FIRST_NAME|there}}}`, `{{{RESEND_UNSUBSCRIBE_URL}}}`).

---

## 7. Consent + unsubscribe (R26, R28, R33)

- One write path: `await envoy.consent.set({ email, topicKey, stream, status })`. Writes the mirror first (authoritative), then confirms the push to Resend (R28).
- **Dual-stream:** `digest` (opt-in) and `alert` (default-on) are independent per `(contact, topic)`; defaults from `createEnvoy({ streams })`.
- **Unsubscribe differs by lane (R33), both topic-scoped:**
  - **Drip/transactional:** the SDK sets `List-Unsubscribe` + one-click headers via `emails.send`, pointing at the **SDK-owned topic-scoped** landing (HMAC-SHA256 token, ≥60-day expiry, rate-limited).
  - **Broadcast:** `broadcasts.create` has **no headers field** — use Resend's **native** unsubscribe (`{{{RESEND_UNSUBSCRIBE_URL}}}` in the body). Because each broadcast carries a `topicId` and your Topics are **public**, Resend's hosted preference page lets the recipient "unsubscribe from certain Topics (types of email)" (topic-scoped, keeps the rest) or "unsubscribe from everything" (global, their explicit choice). The topic opt-out leaves `unsubscribed=false` and is caught by reconcile (R29); only "everything" sets the global flag. **Do not** build your own broadcast-unsubscribe link — Resend's page already gives per-type/per-topic control; the consent gate (R28/R29) syncs it into the mirror.

---

## 8. Contact sync + reconcile + webhooks (R10, R29, R37, R41)

- On enroll/consent change the SDK pushes to Resend: upsert Contact → add to base Segment → set Topic opt-state (R37, all awaited).
- Register the Resend webhook (in the Resend dashboard) for `email.*` **and** `contact.*` → your mounted webhook URL. The SDK Svix-verifies (R41) and reconciles per-topic state via `contacts.topics.list` (since the payload has no `topic_id`, R29).
- A reconcile sweep runs before each broadcast and repairs **both** Topic opt-state and base-Segment membership (intersection targeting, R29).

---

## 9. GDPR deletion (R34)

```ts
await envoy.contacts.delete(email); // suppress-first, then best-effort delete Resend Contact + membership
```

A broadcast already accepted for dispatch can't be recalled (§11). Data already sent to the AI agent is outside this delete (§11, R44).

---

## 10. MCP (optional, R25)

The mounted route exposes an MCP endpoint so an AI agent can operate the lifecycle (enroll, define programs, send, inspect state). It is **independently authenticated** (R42) — treat it as an admin API. Don't expose it unauthenticated.

---

## 11. Known compliance residuals — surface these to your counsel (R39)

These are bounded and mitigated; surface them for sign-off:
1. **Reconcile→fan-out window (narrowed)** — reconcile runs last before create, immediate send only (no `scheduledAt`), opt_outs confirmed in Resend membership first; residual = Resend's create→fan-out latency (seconds).
2. **Advance = accepted, not delivered** — a provider delivery failure is not re-sent.
3. **Mid-broadcast deletion** — can't recall an accepted broadcast (suppress-first stops all *future* sends).
4. **Topic unsubscribe = resolved** — Resend's preference page is topic-scoped (public Topics, per type/subject); only an explicit "unsubscribe from everything" is global, which is the recipient's own choice.
5. **Crash-after-accept (narrowed)** — resume prechecks `broadcasts.list` with bounded retry for replication lag (no Resend broadcast idempotency key).
6. **Anthropic-session PII (mitigated)** — field allow-list + pseudonymized identifiers + Anthropic zero-data-retention; the broadcast lane forwards nothing to the agent.

---

## 12. Adoption map — if you already hand-rolled this (delete-and-import)

If your repo already calls Resend directly for a newsletter (the common case), replace your code with SDK calls:

| Your hand-rolled code | Replace with |
|---|---|
| Resend Contact/Segment/Topic sync wrapper | `envoy.enroll` / `envoy.consent.set` / `program` (R10/R37) |
| `(country, issue_seq)` claim + send-once SQL | `program.runIssue` / claim primitive (R30) |
| Webhook `contact.*` diff + reconcile sweep | mounted webhook + reconcile (R29/R41) |
| Unsubscribe token signing + landing | SDK-owned landing (R33) |
| Per-country cadence/watermark loop | `program.cursor` + your cron body (R36) |
| Digest body assembly | keep your content query + `render`; SDK does fetch-fill-push |
| Direct `resend.emails.send` for the welcome/receipt email | `envoy.send.transactional` (R46) — mirror-gated + idempotent |

Keep: your auth, your content `SELECT`, your CTA/settings UI, your cron *schedule*. Delete: the claim SQL, reconcile diff, consent CAS, Resend coupling, token signing — the ~600 lines that are error-prone.

---

## 13. Final integration checklist

- [ ] `resend@^6.14.0` installed; migrations applied.
- [ ] All secrets set (§2); none read from `process.env` inside SDK calls or logged.
- [ ] Route handler mounted; `authorize` returns correctly; cron/webhook/unsubscribe/MCP secrets present.
- [ ] Resend webhook registered for `email.*` + `contact.*`.
- [ ] Base Segment + per-subject Topics provisioned; ids cached.
- [ ] Drip Templates expose declared AI slots (config-time validation passes, R45).
- [ ] Broadcast content query orders by a non-null column.
- [ ] Two crons wired if running broadcasts (drip + newsletter).
- [ ] Compliance residuals (§11) reviewed by counsel.
- [ ] Single-tenant invariant honored (one namespace = one tenant).
