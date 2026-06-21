---
title: "feat: Build @envoy/sdk as a separate in-repo package"
date: 2026-06-21
type: feat
origin: docs/brainstorms/2026-06-21-envoy-resend-sdk-rearchitecture-requirements.md
---

# feat: Build @envoy/sdk — a headless Resend drip+broadcast email SDK, as a separate in-repo package

## Summary

Build a new, self-contained package `@envoy/sdk` under `packages/sdk/` that an indie SaaS developer drops into their own Next.js (App Router) app. It ships a headless drip engine (event-driven enrollment, time-based sequences, just-in-time per-recipient AI personalization via Claude Managed Agents), a Resend-native broadcast lane (Topics, per-topic consent, send-once claim, reconcile), a transactional send, a mountable route handler (per-sub-path auth), webhooks, an SDK-owned unsubscribe landing, an MCP endpoint, and read-only React hooks — all on `resend@^6.14.0`, bring-your-own-Postgres, host-owns-auth, single-tenant.

The existing Envoy app is **untouched**: the SDK shares no runtime code with it and modifies none of the app's source. The only app-side change is **isolation config** — excluding `packages/` from the app's root `tsconfig`/ESLint so the app's `next build` never compiles SDK files (see origin: R47/R47a). The work is phased so the differentiated **drip lane** lands first (the wedge to validate), the broadcast-program primitives follow, and surfaces (MCP, hooks) come last.

---

## Problem Frame

Envoy's value — multi-step, time-based, per-recipient-AI-personalized email sequences triggered by a host's own product events — is today locked inside a standalone app (OAuth, SES, a visual builder, multi-tenancy) that no indie dev can adopt incrementally. This plan extracts that value into an importable package **without touching the running app**, so the app keeps working exactly as-is while a host can `npm i @envoy/sdk`, run migrations, mount a route handler, and call `enroll()` from their own events (see origin: Problem Frame, Key Decisions).

The hard constraints come from Resend's actual `6.14.0` surface (verified against published type defs): broadcasts take `react|html|text` only (no `templateId`, no `headers`, no idempotency key); `templates.get` returns the template body; `emails.send` takes `template` + idempotency key + headers; Audiences are deprecated in favor of global Contacts + static Segments + Topics; the `contact.updated` webhook carries no `topic_id`. Every unit below is shaped to those facts.

---

## Key Technical Decisions

- **KTD1 — Detached package, not a workspace member.** `packages/sdk/` has its own `package.json`, lockfile, `tsconfig`, and build/test toolchain (`tsup` + Vitest) and installs its own deps under `packages/sdk/node_modules`. The app's root `package.json` gets **no** `workspaces` field and no new dependency — this keeps `resend`/`svix` out of the app's `node_modules` and preserves the no-shared-runtime boundary (origin R47). Building the SDK in-repo against the app's toolchain is explicitly avoided; the SDK builds in isolation and is consumed by hosts.
- **KTD2 — Isolation config is the one permitted app edit.** Add `packages/` to the app's root `tsconfig.json` `exclude` and `eslint.config.mjs` ignore. Without this, the root `include: ["**/*.ts","**/*.tsx"]` pulls `packages/sdk` into the app's `next build` and breaks it on the SDK's `resend` import. These edits change no app behavior; "app builds + app tests pass with `packages/sdk/` present" is U1's verification (origin R47a).
- **KTD3 — Own path alias, never the app's `@/`.** The app maps `@/*` → repo root. The SDK's `tsconfig` defines its own alias (`@sdk/*` → `packages/sdk/src`) or uses relative imports only, so an accidental `@/lib/...` in SDK code resolves to nothing instead of silently importing the app (origin R48; feasibility finding).
- **KTD4 — Two build entry points: server + client.** The package exports `.` (server-only: route handler, db, Resend, agent, primitives) and `./client` (React hooks, `"use client"`). `tsup` emits ESM + `.d.ts` for both. `migrations/` ships as raw `.sql` assets (host applies them). This keeps server-only code (`import "server-only"`) out of client bundles.
- **KTD5 — Reimplement app patterns, never import them.** The agent-session Managed-Agents flow, the claim-on-conflict idiom, and webhook verification are re-authored in SDK-owned code mirroring the app's patterns (`lib/agent-session.ts`, `0045` claim, `app/api/webhooks/resend`) — referenced for shape, not imported (origin R48).
- **KTD6 — BYO-Postgres via an injected pool.** `createEnvoy({ db })` takes the host's `pg`/Neon pool. All SDK tables are namespace-prefixed (KTD7). The SDK ships `.sql` migrations under `packages/sdk/migrations/`; it provides a tiny migrate helper but never runs against the app's schema, and the app's `scripts/migrate.ts` (which scans only the app's `migrations/`) never sees the SDK's (origin R5/R48).
- **KTD7 — Single-tenant, fail-loud namespace.** No `organization_id`. `createEnvoy({ installNamespace })` prefixes every program/subject/contact key and is fingerprint-checked so two installs sharing one Postgres fail loudly rather than cross-contaminate (origin R7/R38).
- **KTD8 — Per-sub-path auth, not uniform.** The route handler runs `authorize(req)` for API/read endpoints, a constant-time `CRON_SECRET` for cron, Svix verify for webhooks, a signed token for unsubscribe, and a dedicated credential for MCP — each independently authenticated because cron/webhook/recipient callers carry no host session (origin R6/R40/R41/R42).
- **KTD9 — Resend Topics are the unsubscribe gate.** Public per-`(stream, subject)` Topics + `opt_in` default + every broadcast carrying `{ segmentId, topicId }` means Resend's hosted preference page is topic-scoped; the SDK consent mirror + reconcile sweep (contact webhook has no `topic_id` → `contacts.topics.list` diff) is the bridge that syncs it. The mirror is authoritative for the SDK's own gating with a monotonic `unsubscribed`-dominates merge (origin R26/R27/R28/R29/R33).
- **KTD10 — Send-once without an idempotency key.** Broadcasts have no Resend idempotency key, so every send is guarded by an atomic claim row on a host `broadcastKey` (`INSERT … ON CONFLICT DO NOTHING`, claim-before-send), with crash-resume via a deterministic broadcast `name` + a `broadcasts.list` precheck with bounded retry. `emails.send` (drip + transactional) uses Resend's native idempotency key (origin R30/R46).

---

## Output Structure

New package (the app's tree is unchanged except the two isolation-config edits in U1):

```text
packages/sdk/
  package.json                 # name @envoy/sdk, exports ., ./client, ./migrations; own deps (resend, svix, @anthropic-ai/sdk)
  tsconfig.json                # own paths alias (@sdk/* -> src), no @/ 
  tsup.config.ts               # two entries: src/index.ts (server), src/client/index.ts (client)
  vitest.config.ts             # node env; jsdom opt-in for hook tests
  migrations/
    001_core.sql               # contacts mirror, per-topic consent, cursor/state, broadcast claims (namespaced)
  src/
    index.ts                   # server entry: createEnvoy + types
    config.ts                  # createEnvoy, EnvoyConfig, namespace fingerprint
    db/
      pool.ts                  # injected pool wrapper, namespaced query helpers, rows.length success
      migrate.ts               # tiny runner over migrations/*.sql (host-invoked)
    resend/
      client.ts                # lazy Resend client; no-op when key unset
      topics.ts                # provision/cache Topics, contacts.topics.update/list
      segments.ts              # base Segment membership push
      templates.ts             # templates.get fetch + in-code variable fill
    consent/
      mirror.ts                # dual-stream per-topic mirror, monotonic merge (the gate)
      unsubscribe.ts           # signed HMAC token (expiry), List-Unsubscribe header builder
    agent/
      session.ts               # reimplemented Managed-Agents JIT generation
    drip/
      sequence.ts              # defineSequence, enroll, step state
      engine.ts                # JIT generate -> emails.send(template) -> advance; fail-safe
      transactional.ts         # send.transactional (required stream, idempotency)
    broadcast/
      claim.ts                 # send-once claim + crash-resume precheck
      cursor.ts                # watermark/issue-seq read/due/advance
      reconcile.ts             # contacts.topics.list diff + segment repair; dirty-set + full-sweep
      render.ts                # fetch Resend Template -> {html,text}, merge tags preserved
      program.ts               # defineBroadcastProgram + runIssue
    route/
      handler.ts               # createEnvoyHandler: per-sub-path auth dispatch
      webhook.ts               # Svix verify, email.* + contact.* ingest
      mcp.ts                   # MCP endpoint (authed)
    validate.ts                # config-time validation (template slots, stream, watermark type)
    client/
      index.ts                 # "use client" hooks: useProgramState, useConsent, useBroadcastHistory, useAnalytics
  example/                     # internal dogfood app run against a real Resend account
    README.md
  test/                        # mirrors src/
```

---

## Requirements Traceability

Origin requirements (`docs/brainstorms/2026-06-21-...-requirements.md`) map to units. Phasing follows origin's "validate drip lane first": Phase 1-3 deliver the drip wedge + plumbing; Phase 4 the broadcast program; Phase 5 surfaces.

- Packaging & isolation (R47, R47a, R48, R5) → U1, U2
- SDK surface / config / secrets (R1, R3, R24, R43, R44, R38, R7) → U1, U3
- Route handler + per-sub-path auth (R2, R6, R40, R41, R42) → U4
- Webhooks + reconcile (R22, R29, R41) → U5, U14
- Consent + unsubscribe (R26, R28, R33) → U6
- Contacts + sync + GDPR (R8–R11, R27, R34, R37) → U7
- Drip lane (R12–R16, R23, R20, R21) → U8, U9
- Transactional send (R46) → U10
- Broadcast send-once + render + targeting (R17–R19, R30, R31, R32) → U11, U12
- Broadcast cadence + program (R35, R36) → U13, U15
- MCP + hooks (R25, R4) → U16, U17
- Config-time validation (R45) → U18, U10
- Compliance residuals surfaced to host (R39) → Scope Boundaries → "Known compliance residuals" (carried from origin; documentation, not a code unit)
- Dogfood example (origin Evidence note) → U19

---

## Implementation Units

Grouped into five phases. Dependencies cite U-IDs. All paths repo-relative.

### Phase 1 — Package foundation + isolation

### U1. Scaffold `packages/sdk/` and isolate it from the app build

- **Goal:** A buildable, test-runnable detached package that the app's build, typecheck, lint, and test all ignore (origin R1, R47/R47a, KTD1/KTD2/KTD3/KTD4).
- **Requirements:** R1, R47, R47a
- **Dependencies:** none
- **Files:** `packages/sdk/package.json`, `packages/sdk/tsconfig.json`, `packages/sdk/tsup.config.ts`, `packages/sdk/vitest.config.ts`, `packages/sdk/src/index.ts`, `packages/sdk/src/client/index.ts`, `tsconfig.json` (app root — add `packages` to `exclude`), `eslint.config.mjs` (app root — ignore `packages/`), `vitest.config.ts` (app root — add `packages/` to `exclude`)
- **Approach:** `package.json` name `@envoy/sdk`, `type: module`, `exports` map `"."` → server build, `"./client"` → client build, `"./migrations/*"` → raw sql; deps `resend@^6.14.0`, `svix`, `@anthropic-ai/sdk`, `server-only`, `@modelcontextprotocol/sdk`, `mcp-handler` (the last two for U16; same versions the app pins); devDeps `tsup`, `vitest`, `typescript`. `tsconfig` `paths` `@sdk/*` → `src/*`, no `@/`. `tsup.config.ts` two entries (server, client) → ESM + dts; **the client entry injects a `"use client"` banner** (esbuild strips directives by default) and marks `server-only` external so the guard module never lands in the client bundle. Root app edits (the only app-side changes, all isolation-only): add `"packages"` to root `tsconfig.json` `exclude`, `eslint.config.mjs` ignores, AND root `vitest.config.ts` `exclude`. **No `workspaces` field added to root `package.json`** — `resend`/`svix` install only under `packages/sdk/` (the no-shared-runtime boundary is an in-repo guarantee; host-side `node_modules` hoisting is the host's concern, see Risks).
- **Patterns to follow:** app `vitest.config.ts` env setup; app `tsconfig.json` shape (mirror compiler options, not the `@/` path); a `no-restricted-imports` rule in the SDK's own eslint config forbidding `@/` so an app import can't slip in.
- **Execution note:** This unit is the isolation gate — land it and verify the app is unaffected before any SDK logic.
- **Test scenarios:**
  - Test expectation: none — scaffolding/config. Verification is build-level.
- **Verification:** `cd packages/sdk && npx tsup` produces server + client bundles + types, and the emitted `./client` entry starts with the `"use client"` directive; `cd packages/sdk && npx vitest run` runs (0 tests OK); from repo root `npx next build` succeeds, `npx vitest run` reports zero SDK files collected, and the app test suite passes with `packages/sdk/` present.

### U2. DB layer + migrations (namespaced, host-applied)

- **Goal:** A thin injected-pool wrapper, namespaced query helpers, and the SDK's own SQL migrations — never touching the app's schema (origin R5, R38, R48, KTD6/KTD7).
- **Requirements:** R5, R38, R48
- **Dependencies:** U1
- **Files:** `packages/sdk/src/db/pool.ts`, `packages/sdk/src/db/migrate.ts`, `packages/sdk/migrations/001_core.sql`, `packages/sdk/test/db/migrate.test.ts`, `packages/sdk/test/db/pool.test.ts`
- **Approach:** `pool.ts` wraps a host-supplied `pg`-compatible pool; all writes namespace-prefix keys; success derived from `rows.length` (Neon returns no `rowCount`). `001_core.sql` defines: `contacts` (email, json data, resend_contact_id, namespace), `topic_consent` (`(namespace, contact, topic_key)` → digest_status/alert_status, opt-state snapshot), `program_state` (cursor: watermark, issue_seq, last_fired_at, paused), `broadcast_claims` (`(namespace, broadcast_key)` PK, sent_at, resend_broadcast_id, item_ids[]), `enrollments`/`steps` (drip). Migration is bare statements (no inline `--`), mirroring app convention. `migrate.ts` is idempotent via a namespaced `sdk_schema_migrations` tracking table (mirroring the app's `000_migration_tracking.sql`): it reads the applied-version set and skips already-applied files, so a host re-running migrate on deploy never re-executes DDL (don't rely on `IF NOT EXISTS` alone).
- **Patterns to follow:** app `lib/db.ts` (pool, `rows.length`), `000_migration_tracking.sql` (the applied-versions tracking table), `045_session_resume.sql` (claim/resume row shape), `scripts/migrate.ts` runner (reimplemented, not imported), `docs/solutions/2026-06-19-crm-lifecycle-sync-cas-gate.md` (CAS gate, Neon rows.length).
- **Test scenarios:**
  - Happy: migrate applies all `001_core.sql` statements to a test pool; re-run is idempotent.
  - Happy: a namespaced upsert creates one row; a second upsert for the same key updates, not duplicates.
  - Edge: query helper derives success from `rows.length`, not `rowCount`.
  - Edge: two namespaces writing the same logical key do not collide.
- **Verification:** Migrations apply cleanly to a fresh test DB; namespaced helpers isolate rows per install.

### U3. `createEnvoy` config, secrets, namespace fingerprint, Resend client

- **Goal:** The root handle: config validation, secret intake, install-namespace fingerprint, lazy Resend client, AI field allow-list, stream defaults (origin R3, R24, R38, R43, R44, R7, KTD7).
- **Requirements:** R3, R24, R38, R43, R44
- **Dependencies:** U2
- **Files:** `packages/sdk/src/config.ts`, `packages/sdk/src/resend/client.ts`, `packages/sdk/src/index.ts`, `packages/sdk/test/config.test.ts`
- **Approach:** `createEnvoy(cfg)` validates required secrets (`resendApiKey`, `webhookSecret`, `cronSecret`, `unsubscribeSecret`, `baseSegmentId`), `installNamespace`, `streams` defaults, optional `agent`, `aiFieldAllowList`. Fingerprint the namespace into a `program_state`-adjacent row and fail loud on mismatch (another install detected). `client.ts` lazily constructs the Resend client; unset `RESEND_API_KEY` ⇒ no-op (mirrors app mailer). Secrets are never logged/serialized; redaction helper for any contact email in logs.
- **Patterns to follow:** `lib/env.ts` Zod validation; `lib/ses.ts` / `lib/agent-session.ts` lazy-client + getClient-singleton (the app's lazy-no-op-when-key-unset pattern lives there — there is no `lib/email/mailer.ts`).
- **Test scenarios:**
  - Happy: `createEnvoy` with full config returns a handle exposing server fns.
  - Error: missing `unsubscribeSecret`/`cronSecret`/`webhookSecret` throws a clear config error (not at send time).
  - Edge: unset `RESEND_API_KEY` makes Resend calls no-op without throwing.
  - Edge: a second `createEnvoy` with a different namespace against a fingerprinted DB fails loud.
  - Edge: log assertion proves no secret or full email is emitted.
- **Verification:** Config errors surface at init; namespace guardrail fires; Resend client lazy + no-op safe.

---

### Phase 2 — Route handler, auth, webhooks, consent, unsubscribe

### U4. Route-handler factory with per-sub-path auth

- **Goal:** `createEnvoyHandler({ authorize })` mounted at one catch-all route, dispatching sub-paths with independent auth (origin R2, R6, R40, R41, R42, KTD8).
- **Requirements:** R2, R6, R40, R41, R42
- **Dependencies:** U3
- **Files:** `packages/sdk/src/route/handler.ts`, `packages/sdk/test/route/handler.test.ts`
- **Approach:** Catch-all parses sub-path: `/api`+`/read` → `authorize(req)`; `/cron` → constant-time `CRON_SECRET`; `/webhook` → Svix (U5); `/unsubscribe` → signed token (U6); `/mcp` → dedicated MCP credential (U16). Each path that bypasses `authorize` enforces its own mechanism; an unauthenticated request to any path is rejected. Returns App Router-compatible `GET`/`POST`.
- **Patterns to follow:** app `app/api/cron/*` cron-secret check (`lib/cron-utils.ts`), `lib/webhook-auth.ts` timing-safe compare (reimplemented).
- **Test scenarios:**
  - Covers R6. Happy: an API request passing `authorize` proceeds; failing `authorize` returns 401 with no state change.
  - Happy: cron path with correct `CRON_SECRET` proceeds; wrong/absent secret → 401.
  - Edge: cron/webhook/unsubscribe paths do NOT call `authorize` (asserted) but enforce their own auth.
  - Error: MCP path with no credential → 401 (never open).
- **Verification:** Each sub-path authenticates by its own mechanism; no path is unauthenticated.

### U5. Resend webhook receiver + contact-event ingest

- **Goal:** Svix-verified ingest of `email.*` (analytics/suppression) and `contact.*` (change-signal → reconcile), with no `topic_id` in the payload (origin R22, R29, R41).
- **Requirements:** R22, R29, R41
- **Dependencies:** U4, U6
- **Files:** `packages/sdk/src/route/webhook.ts`, `packages/sdk/test/route/webhook.test.ts`
- **Approach:** Verify Svix signature before parse (`resend.webhooks.verify`/`svix`); branch on event family before any `email_id` guard (contact events carry none). On `contact.updated`: resolve `email|id → contact` (redact email from logs), trigger the reconcile diff (U14) rather than trusting the payload; a global `unsubscribed=true` suppresses all topics. `email.*` updates delivery/suppression analytics. Never 500 on an unknown/foreign event — ack-and-ignore.
- **Patterns to follow:** the app's SES webhook handler `app/api/webhooks/ses/route.ts` + `lib/sns-verify.ts` (verify-before-parse + never-500) and `lib/webhook-auth.ts` (timing-safe compare), reimplemented for Svix. (The app is SES-based — there is no `app/api/webhooks/resend/` or `lib/email/email-status.ts`; reimplement the verify-before-parse behavior, don't import.)
- **Test scenarios:**
  - Covers R41. Happy: a Svix-valid `contact.updated` resolves the contact and enqueues a reconcile.
  - Edge: global `unsubscribed=true` suppresses the contact across all topics.
  - Regression-shape: an `email.bounced` updates suppression and does not hit the contact-reconcile path.
  - Error: an unverified (bad Svix) webhook returns 401 and writes nothing.
  - Edge: a `contact.*` event whose email matches no contact is acked-and-ignored (no 500), no full email in logs.
- **Verification:** Forged webhooks rejected; contact events drive reconcile; delivery path intact.

### U6. Consent mirror (the gate) + unsubscribe landing

- **Goal:** Dual-stream per-topic consent mirror with monotonic merge, one `consent.set` write path, and the SDK-owned signed topic-scoped unsubscribe landing + `List-Unsubscribe` header builder (origin R26, R28, R33, KTD9).
- **Requirements:** R26, R28, R33
- **Dependencies:** U3
- **Files:** `packages/sdk/src/consent/mirror.ts`, `packages/sdk/src/consent/unsubscribe.ts`, `packages/sdk/test/consent/mirror.test.ts`, `packages/sdk/test/consent/unsubscribe.test.ts`
- **Approach:** `mirror.ts`: `(contact, topic)` row with `digest_status` (opt-in default) + `alert_status` (default-on), atomic upsert with monotonic merge (`unsubscribed` dominates either side). `consent.set({ email, topicKey, stream, status })` writes mirror first, then awaits `contacts.topics.update` push; `consent.gate(...)` reads mirror authoritatively. `unsubscribe.ts`: HMAC-SHA256 signed per-`(contact, topic, stream)` token with mandatory expiry (≥60d), a `List-Unsubscribe`/`List-Unsubscribe-Post` header builder for `emails.send`, and a landing handler that verifies token, writes topic-scoped `opt_out`, returns 200 blank (RFC 8058, no redirect), is rate-limited, and returns uniform responses (no oracle).
- **Patterns to follow:** `docs/solutions/2026-06-19-crm-lifecycle-sync-cas-gate.md` (CAS, monotonic merge, suppress-at-every-site); the app's `lib/rate-limit.ts` (a single file, not a `lib/rate-limit/` dir), reimplemented; `lib/webhook-auth.ts` timing-safe compare for token verification.
- **Test scenarios:**
  - Covers R26. Happy: `consent.set` digest off writes `unsubscribed` + opts the Topic out; `gate` then denies.
  - Edge: monotonic merge — a stale active never overrides an unsubscribed (either side).
  - Happy: a valid one-click unsubscribe POST writes topic-scoped `opt_out`, returns 200 blank, no redirect.
  - Error: forged/expired token rejected (no state change); responses uniform for invalid vs already-unsubscribed.
  - Edge: rate-limit trips after N requests.
- **Verification:** The mirror gates every send; unsubscribe is topic-scoped, signed, expiring, rate-limited.

---

### Phase 3 — Contacts, sync, and the drip lane (the v1 wedge)

### U7. Contacts, SegmentSync, Topic provisioning, GDPR deletion

- **Goal:** `enroll`, the contact mirror, push to Resend (Contact + base Segment + Topic opt-state), idempotent Topic provisioning, and right-to-erasure (origin R8–R11, R27, R34, R37, KTD9).
- **Requirements:** R8, R9, R10, R11, R27, R34, R37
- **Dependencies:** U3, U6
- **Files:** `packages/sdk/src/resend/topics.ts`, `packages/sdk/src/resend/segments.ts`, `packages/sdk/src/contacts.ts`, `packages/sdk/test/contacts.test.ts`, `packages/sdk/test/resend/topics.test.ts`
- **Approach:** `enroll({ email, data }, sequenceKey)` upserts the mirror contact (idempotent no-op if already active), then `sync.push`: upsert global Contact → `contacts.segments.add(base)` → `contacts.topics.update(opt-state)`, all awaited; partial failure marks the row reconcile-dirty. Topics provisioned idempotently per `(stream, subject)`, **public**, `opt_in`, `topicId` cached. `contacts.delete(email)` suppresses mirror first, then best-effort deletes the Resend Contact + Segment/Topic membership (fail-soft, suppress-before-delete).
- **Patterns to follow:** best-effort fail-soft external sync as described in `docs/solutions/2026-06-19-crm-lifecycle-sync-cas-gate.md` (there is no `lib/crm` module to mirror — implement the behavior: await pushes, mark-dirty on partial failure, never throw into the caller); `lib/agent-session.ts` getClient lazy pattern.
- **Test scenarios:**
  - Covers R11. Happy: a new enroll upserts the mirror + opts the Topic in (mocked Resend); re-enroll of an active contact is a no-op.
  - Happy: provisioning is idempotent — second provision returns the cached `topicId`, creates nothing.
  - Edge: a partial `sync.push` failure marks the row reconcile-dirty and returns a non-throwing status.
  - Covers R34. Happy: delete suppresses mirror first, then removes the Resend Contact + membership; Resend failure is fail-soft.
  - Edge: unset `RESEND_API_KEY` makes push a silent no-op.
- **Verification:** Enroll syncs Contact/Segment/Topic; provisioning idempotent; deletion suppress-first + fail-soft.

### U8. Drip engine — sequences, JIT AI personalization, fail-safe send

- **Goal:** `defineSequence`, step state, time-based waits, JIT Claude generation of declared slots, inject into a Resend Template via `emails.send`, fail-safe (origin R12–R16, R23, R45, KTD5).
- **Requirements:** R12, R13, R14, R15, R16, R23
- **Dependencies:** U3, U7
- **Files:** `packages/sdk/src/drip/sequence.ts`, `packages/sdk/src/drip/engine.ts`, `packages/sdk/src/agent/session.ts`, `packages/sdk/test/drip/engine.test.ts`, `packages/sdk/test/agent/session.test.ts`
- **Approach:** `defineSequence({ key, steps })` where each step = `{ templateId, waitDays, aiSlots, brief }`. `agent/session.ts` reimplements the **full** Managed-Agents flow, not just the happy path: it persists the session id as an **inflight crash-resume marker** (`agent_session_id` on the enrollment/step row) **before** the billed turn; generation opens the SSE before sending the goal message, accumulates `agent.message`, stops on idle, content-seek extracts the declared slots from allow-listed contact data + brief. A re-claimed step whose marker is non-null **harvests** the prior session instead of forking a second billed one, and **defers** when that session is still `running` (the timeout window can equal the cron re-claim window — this is what prevents double-billing AND double-send under cron retry, R21). `engine.ts`: for a due step, generate-or-harvest, then `emails.send({ template: { id, variables } }, { idempotencyKey })` — the idempotency key is a **request option (`Idempotency-Key` header), not a body field**; advance state; on generation/send failure, leave the step due (retry later), never sent empty, never silently dropped. Waits resolved against the cron clock.
- **Patterns to follow:** `lib/agent-session.ts` (`runAgentSession` + `harvestAgentSession` + the `onSessionCreated` inflight-marker contract — reimplemented), `045_session_resume.sql` (the marker-column shape), `lib/personalization.ts` semaphore concurrency, `lib/agent-sanitize.ts` (payload sanitization).
- **Test scenarios:**
  - Covers R14. Happy: a due step generates declared slots and sends via `emails.send` with the template id + variables; the idempotency key is sent as the `Idempotency-Key` request header (asserted), not in the body.
  - Covers R16. Error: a generation/send failure leaves the step due for retry; nothing sent empty.
  - Error: a re-claimed step whose prior session is still `running` is **deferred** (no second billed session forked); a `completed` prior session is **harvested**, not regenerated (no double-bill, no double-send).
  - Edge: a "wait 3 days" step is skipped until the next-eligible time passes.
  - Edge: only allow-listed contact fields reach the agent payload (R44).
  - Edge: suppression mirror denies a suppressed contact before send.
- **Verification:** Steps personalize + send on schedule; failures retry safely; AI sees only allow-listed fields.

### U9. Drip cron handler

- **Goal:** The mounted cron tick that finds due steps and runs the engine, safe under overlapping ticks (origin R20, R21).
- **Requirements:** R20, R21
- **Dependencies:** U4, U8
- **Files:** `packages/sdk/src/route/handler.ts` (cron branch), `packages/sdk/src/drip/engine.ts` (tick entry), `packages/sdk/test/drip/cron.test.ts`
- **Approach:** `GET /cron/drip` (CRON_SECRET, U4) claims due contacts with an atomic claim (FOR UPDATE SKIP LOCKED), generates-or-harvests (U8), sends, advances. No-double-send rests on **two** guards together: the row claim protects step selection, and the U8 inflight-marker/harvest protects a generation that times out mid-flight and is re-claimed next tick (it harvests, never re-generates/re-sends). `maxDuration` set; per-contact fail-soft.
- **Patterns to follow:** the app's `email-sender` cron + `claimQueuedEmails` (`lib/queries/system.ts`) SKIP LOCKED claim-and-send, reimplemented.
- **Test scenarios:**
  - Covers R21. Happy: a tick sends all due steps and advances; a second concurrent tick double-sends nothing.
  - Edge: a step whose wait hasn't elapsed is skipped.
  - Error: one contact's failure does not abort the tick (fail-soft).
- **Verification:** Cron drives the drip lane; no double-send under concurrency.

### U10. Transactional send (one-shot, non-AI)

- **Goal:** `envoy.send.transactional` — a single templated `emails.send`, mirror-gated, required stream, List-Unsubscribe, idempotency (origin R46, R45).
- **Requirements:** R45, R46
- **Dependencies:** U6, U7
- **Files:** `packages/sdk/src/drip/transactional.ts`, `packages/sdk/test/drip/transactional.test.ts`
- **Approach:** `send.transactional({ email, templateId, variables, stream, idempotencyKey? })` — `stream` required (scopes the unsubscribe token); consult mirror; `emails.send({ template, headers: { List-Unsubscribe… } }, { idempotencyKey })` — the idempotency key is a **request option (`Idempotency-Key` header), not a body field**. The missing-stream rejection is the validation implemented in U18; U10 enforces it at its call boundary.
- **Patterns to follow:** U6 header builder, U8 `emails.send` usage.
- **Test scenarios:**
  - Covers R46. Happy: a welcome send passes the template id + variables + List-Unsubscribe header + idempotency key (mocked Resend).
  - Error: a call with no `stream` is rejected (not sent without an unsubscribe).
  - Edge: a suppressed contact is not sent.
- **Verification:** One-shot templated sends are gated, stream-scoped, idempotent.

---

### Phase 4 — Broadcast program (sequences after the drip wedge)

### U11. Broadcast send-once claim + crash-resume

- **Goal:** The atomic claim guard + deterministic-name/`broadcasts.list` precheck resume (origin R30, KTD10).
- **Requirements:** R30
- **Dependencies:** U2
- **Files:** `packages/sdk/src/broadcast/claim.ts`, `packages/sdk/test/broadcast/claim.test.ts`
- **Approach:** `claim(broadcastKey)` → `INSERT … ON CONFLICT DO NOTHING RETURNING`; proceed only on a won claim; a pre-existing claim with `sent_at IS NULL` is resumable. The common path persists the returned Resend broadcast id into the claim row immediately after create, so resume normally reads the id directly and never scans. Only when the id is absent (crash in the persist gap) does resume precheck `broadcasts.list`: since `ListBroadcastsOptions` has **no name filter** and the payload is `id`/`name`/`status`/`created_at` only, the precheck pages bounded by `created_at >= claim.created_at` with an explicit max-pages budget and a short retry for replication lag. On budget exhaustion it **fails loud** (requires operator confirmation), never blind-re-creates. Success from `rows.length`.
- **Patterns to follow:** `045_session_resume.sql` (claim/resume marker), `claimQueuedEmails` (`lib/queries/system.ts`) SKIP LOCKED idiom, CAS gate learning.
- **Test scenarios:**
  - Covers R30. Happy: first `claim` wins and returns the row; a concurrent second loses and does not send.
  - Happy: the Resend broadcast id is persisted into the claim row after create; resume reads it directly without listing.
  - Error: a prior crashed claim (`sent_at IS NULL`, id absent) resumes — pages `broadcasts.list` bounded by `created_at` for the deterministic name before re-creating.
  - Error: precheck budget exhausted (high-volume host) → fails loud, does not blind re-create.
- **Verification:** Exactly-once under overlapping ticks; crash-after-accept narrowed by precheck.

### U12. Broadcast render + send (Resend Template → html/text)

- **Goal:** Fetch the Resend Template, fill in code, push `{ html, text }` to `broadcasts.create({ segmentId, topicId, send:true })` (origin R17–R19, R32, KTD9).
- **Requirements:** R17, R18, R19, R31, R32
- **Dependencies:** U3, U7
- **Files:** `packages/sdk/src/resend/templates.ts`, `packages/sdk/src/broadcast/render.ts`, `packages/sdk/test/broadcast/render.test.ts`
- **Approach:** `templates.get(id)` → `html`/`text`; substitute template variables in code; preserve Resend merge tags verbatim (`{{{FIRST_NAME|there}}}`, `{{{RESEND_UNSUBSCRIBE_URL}}}`); cache the fetched template. `broadcasts.create({ segmentId, topicId, from, subject, html, text, name: broadcastKey, send: true, scheduledAt? })` (single-call dispatch). No `templateId`, no headers (broadcast has none).
- **Patterns to follow:** verified Resend facts (origin Sources).
- **Test scenarios:**
  - Covers R32. Happy: render fetches the template, fills variables, leaves merge tags verbatim, produces broadcast-ready html.
  - Edge: the fetched template is cached (second send does not re-fetch).
  - Happy: `broadcasts.create` is called with `{ segmentId, topicId, html, text, send: true }` and no `templateId`/headers.
- **Verification:** Broadcasts render from a Resend Template + dispatch in one call.

### U13. Cursor primitive (watermark, cadence, health)

- **Goal:** `cursor.read/due/advance` owning watermark + issue-seq per `(programKey, subjectKey)`, advance-only-on-send, strict-greater, `lastFiredAt` health (origin R36).
- **Requirements:** R36
- **Dependencies:** U2
- **Files:** `packages/sdk/src/broadcast/cursor.ts`, `packages/sdk/test/broadcast/cursor.test.ts`
- **Approach:** `read(key)` → `{ watermark, issueSeq, lastFiredAt, paused }`; `due(cur, { cadenceDays })` boolean; `advance(key, { watermark, issueSeq, itemIds })` writes only on a real send, strictly-greater compare, rejects null/non-monotonic watermark (U18). `lastFiredAt` exposed for host health alerting.
- **Patterns to follow:** `newsletter_country_state`-style per-key clock (origin), monotonic advance.
- **Test scenarios:**
  - Covers R36. Happy: `due` false within cadence window, true after.
  - Edge: `advance` with a watermark ≤ current is rejected (strict-greater, non-monotonic guard).
  - Edge: skip-zero/only-if-new paths do NOT advance the watermark.
  - Happy: `read` surfaces `lastFiredAt` for health.
- **Verification:** Cadence/watermark correct; advance only on send; non-monotonic rejected.

### U14. Reconcile sweep — topics diff + segment repair + cost control

- **Goal:** The `contacts.topics.list` diff that repairs per-topic opt-state AND base-Segment membership before each broadcast, with dirty-set narrowing, resumable full-sweep, 429 backoff (origin R29, KTD9).
- **Requirements:** R29
- **Dependencies:** U5, U7, U13
- **Files:** `packages/sdk/src/broadcast/reconcile.ts`, `packages/sdk/test/broadcast/reconcile.test.ts`
- **Approach:** `reconcile(subject)` diffs `contacts.topics.list` against the mirror snapshot, writes `opt_out` for flipped topics, AND verifies/repairs base-Segment membership (intersection targeting). `contacts.topics.list` returns entries keyed by **Resend topic id** (`{ id, name, subscription }`), not by `(stream, subject)`, so the diff maps `topicId → (stream, subject)` via the U7 provisioning cache; an entry whose id is **absent from the cache** (provisioned out-of-band, or a cache restored older than the last provision) **fails loud** — the contact is marked reconcile-dirty and surfaced, never silently ignored (an ignored opt_out is a consent leak). Provisioning (U7) maintains the invariant that every SDK-targeted topic is round-trippable id↔(stream,subject). Per-tick narrowed to a dirty-set (`mirror.dirtySince`); a resumable full-sweep cursor runs across ticks; explicit 429 backoff on the Resend client. Runs as the **last** step before `broadcasts.create` (narrows the fan-out window).
- **Patterns to follow:** monotonic merge (U6), CAS learning.
- **Test scenarios:**
  - Covers R29. Happy: a topic flipped to opt_out in Resend is written to the mirror by reconcile.
  - Edge: a contact opted-in on the Topic but missing from the base Segment is repaired (added), else it silently receives nothing.
  - Edge: dirty-set narrows the per-tick sweep; full-sweep resumes via its own cursor.
  - Error: a 429 mid-sweep backs off and resumes, does not abort the issue.
  - Error: a `contacts.topics.list` entry whose id is absent from the provisioning cache fails loud (contact marked reconcile-dirty + surfaced), never silently ignored.
- **Verification:** Reconcile converges mirror↔Resend per topic + segment; bounded at scale; no unmapped opt_out silently dropped.

### U15. `defineBroadcastProgram` + `runIssue` convenience

- **Goal:** The declarative program handle + the canonical `reconcile → claim → render → send → advance` ordering, per-subject fail-soft (origin R35).
- **Requirements:** R35
- **Dependencies:** U11, U12, U13, U14
- **Files:** `packages/sdk/src/broadcast/program.ts`, `packages/sdk/test/broadcast/program.test.ts`
- **Approach:** `defineBroadcastProgram({ key, segmentId, topicKeyFor, cadenceDays, render })` returns a handle exposing the raw primitives + `runIssue({ subjectKey, items })` that bundles the proven ordering. Raw primitives stay exported. Per-subject fail-soft (one subject's Resend error never aborts the host loop). Sequencing note: primitives are usable standalone; `runIssue` is the convenience.
- **Patterns to follow:** U11–U14 composition.
- **Test scenarios:**
  - Covers R35. Happy: `runIssue` runs reconcile→claim→render→send→advance in order; a held claim sends once.
  - Error: a fresh concurrent claim loss skips without sending.
  - Error: one subject's Resend failure does not abort the host loop (fail-soft).
- **Verification:** `runIssue` enforces the safe ordering; raw primitives remain available.

---

### Phase 5 — Surfaces + validation + dogfood

### U16. MCP endpoint (authed)

- **Goal:** A mounted MCP server re-pointed at SDK internals so agents can operate the lifecycle, independently authenticated (origin R25, R42).
- **Requirements:** R25, R42
- **Dependencies:** U4, U7, U8, U15
- **Files:** `packages/sdk/src/route/mcp.ts`, `packages/sdk/test/route/mcp.test.ts`
- **Approach:** Build the MCP server with `mcp-handler` + `@modelcontextprotocol/sdk` (the same stack the app uses in `app/mcp/route.ts`; added to U1 deps). The `/mcp` sub-path of `createEnvoyHandler` constructs the handler internally via `createMcpHandler` + `withMcpAuth` (dedicated credential, U4) and returns Web-standard `Request`/`Response` so it stays App-Router-compatible. Expose lifecycle tools (enroll, define/inspect sequences + programs, trigger broadcast, read analytics/state); same write privilege as server fns.
- **Patterns to follow:** app `app/mcp/route.ts` (`createMcpHandler`/`withMcpAuth` wiring) + `lib/mcp-tools.ts` tool-definition shape (reimplemented), single-tenant trimming.
- **Test scenarios:**
  - Covers R42. Happy: an authed MCP call enrolls a contact.
  - Error: an unauthenticated MCP call is rejected.
  - Edge: MCP tool writes honor the suppression mirror (no send to suppressed).
- **Verification:** MCP operates the lifecycle, never unauthenticated.

### U17. Read-only React hooks (client entry)

- **Goal:** `useProgramState`, `useConsent`, `useBroadcastHistory`, `useAnalytics` reading through the mounted route's read API (origin R4).
- **Requirements:** R4
- **Dependencies:** U4
- **Files:** `packages/sdk/src/client/index.ts`, `packages/sdk/test/client/hooks.test.tsx`
- **Approach:** `"use client"` hooks that fetch the mounted route's read endpoints; read-only (writes go through server fns). Fetch strategy minimal (plain fetch + a tiny cache); the package's `./client` export carries these only.
- **Patterns to follow:** standard SWR-less fetch hook; jsdom test env.
- **Execution note:** `// @vitest-environment jsdom` for hook tests.
- **Test scenarios:**
  - Happy: `useProgramState` fetches and returns program cursor state for a subject.
  - Edge: error response surfaces an error state, not a throw.
  - Edge: hooks import only from `./client` (no server-only code in the client bundle).
- **Verification:** Hooks read state for host-built admin screens; client bundle is server-free.

### U18. Config-time validation (fail loud)

- **Goal:** Validate template slots, required transactional stream, and watermark column type at config time (origin R45).
- **Requirements:** R45
- **Dependencies:** U8, U10, U13, U15
- **Files:** `packages/sdk/src/validate.ts`, `packages/sdk/test/validate.test.ts`
- **Approach:** Two kinds of validation. **Synchronous, no network** (at `define*`/call time): a transactional send names a `stream`; a program declares a non-nullable watermark column type (the SDK cannot read host content tables, so the type is declared and `cursor.advance` rejects null/non-monotonic at runtime). **Lazy, network** (the slot↔Template check): each step's declared `aiSlots` are checked against the referenced Template's variables via `templates.get`, fired on **first use** (cached) or an explicit `envoy.validate()` call — never at module-load, so init does not depend on Resend reachability (preserving U3's unset-key no-op). A Template returning `variables: null` (draft/variable-less) is treated as "cannot confirm" (warn), not "no match" (error). Surface as early, actionable errors.
- **Patterns to follow:** U3 config validation.
- **Test scenarios:**
  - Covers R45. Error: a step declaring a slot absent from its Template fails at definition time.
  - Error: a transactional send with no stream fails at definition/call time.
  - Edge: a nullable watermark column type declaration is rejected at setup.
- **Verification:** Host-contract mistakes fail loud at config time, not at send.

### U19. Internal dogfood example app

- **Goal:** A thin example under `packages/sdk/example/` the authors run against a real Resend account so compliance-critical primitives are exercised (origin Evidence & validation note).
- **Requirements:** origin Evidence note
- **Dependencies:** U9, U10, U15
- **Files:** `packages/sdk/example/README.md`, `packages/sdk/example/` (minimal Next.js route + enroll call + a broadcast program)
- **Approach:** A minimal host: `createEnvoy`, mount the handler, `enroll` on a button, define one sequence + one broadcast program, wire both crons. README documents running it against a real Resend test account. Not published; dev-only.
- **Test scenarios:**
  - Test expectation: none — example/dogfood harness, exercised manually against real Resend.
- **Verification:** The example sends a real drip + a real broadcast end-to-end against a Resend test account.

---

## Scope Boundaries

**In scope:** the `@envoy/sdk` package (Phases 1–5) under `packages/sdk/`, plus the two isolation-config edits to the app's root `tsconfig.json`/`eslint.config.mjs` (U1).

**Deferred for later (origin):**
- Making the existing Envoy app consume the SDK (the app stays on its current implementation; adoption is a separate effort).
- A pre-built admin UI kit; optional repo→Resend template publishing; reverse Segment sync; multiple Resend domains/accounts; A/B subject testing; non-Next.js adapters.

**Outside this product's identity (origin):**
- A hosted Envoy SaaS backend; an Envoy-owned auth/identity system; a visual email builder; being an ESP; per-recipient AI in the broadcast lane.

**Deferred to Follow-Up Work (plan-local):**
- Analytics storage shape + aggregation depth behind `useAnalytics` (U17 reads a minimal contract; the richer analytics model is deferred).
- The `defineBroadcastProgram`/`runIssue` convenience (U15) may land after U11–U14 are validated against the example (origin R35 sequencing); raw primitives are the v1 floor.
- CI wiring for the two-install (app + `packages/sdk/`) build/test matrix.

### Known compliance residuals (carried from origin, surfaced per R39)
The SDK surfaces these to the host (it does not bury them); none is closable at the SDK layer:
- Reconcile→fan-out consent window (Resend resolves membership after `broadcasts.create` returns; mitigated by reconcile-last + immediate send).
- `advance` = accepted, not delivered (a provider delivery failure is not re-sent).
- Mid-broadcast GDPR deletion can't recall an accepted broadcast (suppress-first stops future sends only).
- Broadcast crash-after-accept (narrowed by the `broadcasts.list` precheck + bounded paging, U11).
- Anthropic-session PII (allow-list + pseudonymize + ZDR; broadcast lane forwards nothing).

---

## Risk Analysis & Mitigation

- **App build regression from `packages/` (R47a).** *Mitigation:* U1 lands the `tsconfig`/eslint excludes first and its verification is `npx next build` + app tests green with `packages/sdk/` present — the isolation gate before any SDK logic.
- **Accidental app import via `@/`.** *Mitigation:* KTD3 — the SDK's own `@sdk/*` alias; an `@/lib/...` in SDK code resolves to nothing. A lint rule (no-restricted-imports for `@/`) in the SDK's own eslint config enforces it.
- **Two-install dependency drift (`resend`/`svix` not in app `node_modules`).** *Mitigation:* KTD1 detached package with its own lockfile + install; documented build/test commands; CI matrix deferred but noted. *Scope note:* "no shared runtime" is an **in-repo** guarantee (the app's `package.json` never gains `resend`/`svix`). Once a real host installs published `@envoy/sdk` alongside their own deps, npm hoisting may surface the SDK's deps into a shared `node_modules` — that is the host's environment, not this plan's concern.
- **Broadcast send-once without an idempotency key.** *Mitigation:* U11 atomic claim + deterministic-name precheck (crash-after-accept residual surfaced in origin).
- **Reconcile rate-limit/maxDuration at scale.** *Mitigation:* U14 dirty-set + resumable full-sweep + 429 backoff.
- **Compliance residuals (origin Known compliance residuals).** *Carried as accepted residuals*, surfaced to the host (reconcile→fan-out window, advance=accepted, mid-broadcast deletion, Anthropic-session PII) — not closable at the SDK layer.

---

## Dependencies / Prerequisites

- `resend@^6.14.0`, `svix`, `@anthropic-ai/sdk`, `server-only` (SDK deps, installed under `packages/sdk/`).
- A host Postgres (BYO) for the SDK's migrations; a Resend account + key; an Anthropic key + Managed Agent + environment (drip lane only).
- Build/test: `tsup` + Vitest 4 (SDK-local), matching the app's TS 5.9 / Node baseline.
- New env/secrets for a host: `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `CRON_SECRET`, `ENVOY_UNSUBSCRIBE_SECRET`, `RESEND_BASE_SEGMENT_ID`, Anthropic agent config.

---

## Sources & Research

- Origin requirements: `docs/brainstorms/2026-06-21-envoy-resend-sdk-rearchitecture-requirements.md` (R1–R48, Known compliance residuals).
- Verified Resend facts (`resend@6.14.0` type defs + docs): broadcasts `react|html|text` only, no `templateId`/`headers`/idempotency key; `templates.get` returns body; `emails.send` has `template`+idempotency+headers; Audiences deprecated → Contacts/Segments/Topics; `contact.updated` has no `topic_id`; topic-scoped unsubscribe via the hosted preference page (`resend.com/docs/dashboard/topics/introduction`).
- Repo grounding (app, untouched — for pattern reuse-by-reimplementation): `tsconfig.json` (`include: ["**/*.ts"]`, `@/*` → root), `eslint.config.mjs`, `scripts/migrate.ts` (scans only app `migrations/`), `vitest.config.ts`, `lib/db.ts`, `lib/agent-session.ts`, `lib/email/mailer.ts`, `app/api/webhooks/resend/route.ts`, `0045_law_change_notifications.sql`, `lib/cron-utils.ts`, `lib/webhook-auth.ts`.
- Learnings: `docs/solutions/2026-06-19-crm-lifecycle-sync-cas-gate.md` (CAS gate, fail-soft sync, suppress-at-every-site, Neon `rows.length`).
