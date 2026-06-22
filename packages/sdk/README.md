# @catalystiq/envoy-sdk

Headless, bring-your-own-Postgres email SDK for Next.js (App Router). Drop multi-step,
time-based, **per-recipient AI-personalized** drip sequences and Resend-native broadcasts into
your own app — you own auth, the UI, and the database; the SDK owns the engine.

Built on [Resend](https://resend.com) (`resend@^6.14.0`) for transport, Topics, and Broadcasts,
and Claude Managed Agents for just-in-time personalization. Self-hosted, single-tenant.

> Status: early (`0.1.0`). The public surface may still shift.

## Install

```bash
npm i @catalystiq/envoy-sdk resend
```

Peers (optional, host-provided): `next >=14`, `react >=18`.

## What it does

Two clearly separated send lanes:

- **Drip lane** — `defineSequence` + `enroll()` from your app events. Each step renders a Resend
  Template and fills AI-written slots (subject/preheader/body) just-in-time via Claude, sent as an
  individual transactional `emails.send`. Time-based waits, crash-safe agent resume, fail-soft.
- **Broadcast lane** — `defineBroadcastProgram` over Resend Segments + Topics. Content-gated,
  send-once (external claim guard), with per-topic consent reconcile. Merge-vars only, no AI.

Plus: a mountable catch-all route handler (per-sub-path auth: your `authorize` + cron secret +
Svix webhook verify + signed unsubscribe + MCP), a dual-stream consent mirror that gates every
send, an RFC 8058 one-click unsubscribe landing, GDPR contact deletion, read-only React hooks,
and a retained MCP server so AI agents can operate the lifecycle.

## Quick start

```ts
// lib/envoy.ts (server-only)
import "server-only";
import { createEnvoy } from "@catalystiq/envoy-sdk";
import { pool } from "@/lib/db";

export const envoy = createEnvoy({
  db: pool,
  installNamespace: "myapp-prod",
  resendApiKey: process.env.RESEND_API_KEY!,
  webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,
  cronSecret: process.env.CRON_SECRET!,
  unsubscribeSecret: process.env.ENVOY_UNSUBSCRIBE_SECRET!,
  baseSegmentId: process.env.RESEND_BASE_SEGMENT_ID!,
  streams: { digest: { default: "opt_out" }, alert: { default: "opt_in" } },
});
```

```ts
// app/api/envoy/[...envoy]/route.ts
import { envoy } from "@/lib/envoy";
const handler = envoy.routeHandler({ authorize: async (req) => /* your check */ true });
export const GET = handler;
export const POST = handler;
```

Apply the SDK's migrations to your database (it ships `.sql` under `migrations/` and a `migrate`
helper), then `await envoy.enroll({ email, data }, "onboarding")` from your signup event.

## Full integration guide

A complete, step-by-step host integration guide (auth model, the two crons, consent, webhooks,
GDPR, the delete-and-import adoption map, and the accepted compliance residuals) ships in this
package as [`AGENTS.md`](./AGENTS.md) — your coding agent can read it directly from
`node_modules/@catalystiq/envoy-sdk/AGENTS.md`.

## License

MIT
