# @envoy/sdk — internal dogfood example

A thin Next.js (App Router) host that drops in `@envoy/sdk` exactly the way an external
indie SaaS dev would. **Not published.** Its only job is to let the authors exercise the
compliance-critical primitives — the **consent mirror** (the send gate), the **send-once
broadcast claim**, and the **one-click unsubscribe** — end-to-end against a real Resend
test account, instead of trusting unit tests alone.

> This app imports only the package's public entry (`@envoy/sdk`). It shares no code with
> the main Envoy app and never imports `@/...` or the SDK's internal `@sdk/*` alias.

## What it wires

- **`envoy.ts`** — builds the root `Envoy` handle from env (lazy Resend client, no network at
  construction), the consent mirror, **one** drip `welcomeSequence` (a 2-step AI-per-recipient
  welcome), and **one** `digestProgram` broadcast program (a weekly newsletter). Exposes the
  sequence/program registries.
- **`app/api/envoy/[...envoy]/route.ts`** — the single mounted catch-all. Per-sub-path auth
  (KTD8): host `authorize` for `/api`+`/read`, `CRON_SECRET` for `/cron`, Svix for `/webhook`,
  the signed token for `/unsubscribe`, the MCP credential for `/mcp`. The `/cron` slot dispatches
  `/cron/drip` → the drip tick and `/cron/broadcast` → the newsletter `runIssue`.
- **`app/api/enroll/route.ts`** + **`app/enroll-button.tsx`** — the host's own event-driven
  `enroll(...)` call, fired from a button.
- **`scripts/migrate.ts`** — applies the SDK's migrations to your Postgres (BYO).
- **`vercel.json`** — schedules both crons.

## Prerequisites

- A **Resend test account** + API key, with:
  - A verified sending domain (or Resend's onboarding sandbox) and From addresses.
  - A base **Segment** (`RESEND_BASE_SEGMENT_ID`) — the canonical broadcast target.
  - Saved **Templates** for each drip step and the digest, with the variables the steps declare
    (`intro_line`, `nudge_line`, `issue_count`, `lead_title`).
  - A Resend **webhook** pointed at `<EXAMPLE_BASE_URL>/api/envoy/webhook/resend`, signed with
    `RESEND_WEBHOOK_SECRET` (Svix).
- A **Postgres** database (`DATABASE_URL`) — Neon/Supabase/local all work.
- (Drip lane only) an **Anthropic** key + Managed Agent + environment id, for the AI slots.

## Environment

Create `.env.local`:

```bash
# Host
EXAMPLE_BASE_URL=https://your-example.vercel.app
EXAMPLE_ADMIN_TOKEN=pick-a-long-random-string          # gates /api/enroll + /api/envoy/api
NEXT_PUBLIC_EXAMPLE_ADMIN_TOKEN=$EXAMPLE_ADMIN_TOKEN   # the browser form reads this (dev-only)
ENVIRONMENT=prod                                       # "dev" relaxes unset CRON_SECRET only

# Database (BYO Postgres)
DATABASE_URL=postgres://...

# Resend
RESEND_API_KEY=re_...
RESEND_WEBHOOK_SECRET=whsec_...
RESEND_BASE_SEGMENT_ID=seg_...
EXAMPLE_FROM_DIGEST="Acme <digest@acme.dev>"
EXAMPLE_FROM_ALERT="Acme <alerts@acme.dev>"            # optional
EXAMPLE_TEMPLATE_WELCOME_1=tmpl_...
EXAMPLE_TEMPLATE_WELCOME_2=tmpl_...
EXAMPLE_TEMPLATE_DIGEST=tmpl_...

# Cron + unsubscribe secrets (compliance-critical — never unset outside dev)
CRON_SECRET=pick-a-long-random-string
ENVOY_UNSUBSCRIBE_SECRET=pick-a-long-random-string

# MCP (optional) — the /mcp sub-path fails closed when unset
ENVOY_MCP_SECRET=pick-a-long-random-string

# Anthropic / Managed Agent (drip lane only; omit to run the broadcast lane alone)
ENVOY_AGENT_ID=...
ENVOY_AGENT_ENVIRONMENT_ID=...
ANTHROPIC_API_KEY=sk-ant-...
```

## Install & run

This example is its own install (it depends on `@envoy/sdk` as a local `file:..`), so build the
SDK first, then install the example:

```bash
# 1. Build the SDK so the example can resolve @envoy/sdk -> dist
cd packages/sdk && npm install && npm run build

# 2. Install + migrate + run the example
cd example && npm install
DATABASE_URL="$DATABASE_URL" npm run migrate
npm run dev
```

## The end-to-end dogfood walk

This is the manual validation the unit calls for — a real drip + a real broadcast against Resend:

1. **Enroll.** Open the app, enter your own email + a first name, click **Enroll into welcome
   drip**. The result shows `created=true suppressed=false`. (`/api/enroll` → `enroll(...)`.)
2. **Drip send #1.** Trigger the drip cron:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" "$EXAMPLE_BASE_URL/api/envoy/cron/drip"
   ```
   Step 0 (`waitDays: 0`) is due immediately. The engine generates the `intro_line` slot per
   recipient (Claude Managed Agent), sends the templated email through Resend with a RFC 8058
   `List-Unsubscribe` header, and advances the enrollment. Check your inbox.
3. **No double-send.** Hit the same cron URL again right away — the already-advanced enrollment is
   past step 0 and its step-1 wait (3 days) has not elapsed, so nothing re-sends. (Concurrency
   safety is proven in `test/drip/cron.test.ts`; here you confirm it by eye.)
4. **Unsubscribe (the gate).** Click the one-click unsubscribe link in the email. It POSTs the
   signed token to `/api/envoy/unsubscribe`, which writes a **topic-scoped** `opt_out` into the
   consent mirror and returns a uniform blank 200 (no token oracle). Now advance the clock (or set
   `waitDays: 0` on step 1 temporarily) and run the drip cron again — the mirror **gate** denies
   step 1, so the unsubscribed contact receives nothing further.
5. **Broadcast (send-once).** Trigger the broadcast cron:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" "$EXAMPLE_BASE_URL/api/envoy/cron/broadcast"
   ```
   `runIssue` runs the canonical **reconcile → claim → render → send → advance** ordering. The
   example's content query is a stub (empty batch), so `render` returns `null` and the issue
   **skips** without sending — swap in a non-empty `items` array in `envoy.ts`'s `broadcastTick`
   to send a real newsletter. Run it twice with the same issue: the **send-once claim** lets the
   first win and the second lose (no duplicate broadcast), even under overlapping ticks.
6. **Webhook.** Send yourself a test event from Resend (or let a real bounce/complaint arrive). It
   hits `/api/envoy/webhook/resend`, is Svix-verified by the factory, and ingested into the mirror.

## Known residuals (surfaced, not closable here)

Per the requirements doc, the SDK surfaces these to the host rather than burying them; the example
makes them observable but cannot close them:

- The reconcile→fan-out consent window (Resend resolves membership after `broadcasts.create`).
- `advance` means *accepted*, not *delivered* (a provider delivery failure is not re-sent).
- A mid-broadcast GDPR deletion can't recall an already-accepted broadcast.
