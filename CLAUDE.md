# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Drip campaigns that write themselves. Build multi-step email sequences where every message is AI-personalized to each recipient. Envoy researches your prospects and writes unique follow-ups that convert. Open source — self-host or deploy to Vercel in minutes. Exposes an MCP server so AI agents can operate it directly.

## Development Commands

### Local Development
```bash
npm install
npm run dev  # uses Turbopack
```

### Type Checking & Build
```bash
npx next build  # TypeScript is checked during build
```

### Tests
Vitest. `node` env by default; component tests opt in via `// @vitest-environment jsdom` at the top of the file.
```bash
npm test               # run once
npm run test:watch     # watch mode
npm run test:coverage  # coverage report (v8)
```
Tests live in `test/` (mirrors `lib/`, `app/`, `components/`). Shared helpers: `test/helpers/fetch.ts` (`mockFetchQueue`), `test/setup.ts` (env defaults).

### Initial Setup
```bash
npm run migrate              # run database migrations
npm run setup                # create organization + admin user (interactive)
```

### QA
Use agent-browser skill to automate browser interactions for web testing, form filling, screenshots, and data extraction. Use -headed mode by default.

### Database Migrations
```bash
DATABASE_URL="..." npm run migrate
```

### Deployment
Deployed via Vercel. Push to main triggers automatic deployment.

## Architecture

### Tech Stack
- **Runtime**: Next.js 16 (App Router) on Vercel
- **Language**: TypeScript 5.9
- **Frontend**: React 19, Tailwind 4, shadcn/ui, Tiptap (rich text), Recharts, dnd-kit
- **Database**: PostgreSQL (Neon) via `@neondatabase/serverless`
- **Email**: AWS SES v2
- **AI**: Claude Managed Agents (`@anthropic-ai/sdk`, `client.beta.sessions`)
- **Auth**: OAuth 2.1 with PKCE, JWT via jose
- **MCP**: `mcp-handler` for AI agent integration

### Project Structure
- **app/** - Next.js App Router (pages, API routes, cron jobs)
- **components/** - React components (ui, email-builder, sequence-builder, landing, settings)
- **lib/** - Shared TypeScript modules (db, auth, queries, integrations)
- **lib/queries/** - Database query modules (one per resource)
- **migrations/** - PostgreSQL migration files (numbered sequentially)
- **scripts/** - Utility scripts (migrate.ts, setup.ts)
- **test/** - Vitest test files (mirrors `lib/`, `app/`, `components/`)

### App Routes
- **(admin)/** - Protected admin pages: dashboard, targets, campaigns, content, sequences, outbox, analytics, design-templates, settings
- **/login** - Login page
- **/auth** - Auth pages
- **/callback** - OAuth callback
- **/embed** - Embeddable views
- **/unsubscribe/[targetId]** - Public unsubscribe page

### API Routes (app/api/)
- **auth/** - Login/signup endpoints
- **health/** - Health check endpoint
- **oauth/** - OAuth 2.1 endpoints (authorize, token, register, revoke, userinfo, clients)
- **cron/** - Vercel Cron jobs (email-sender, campaign-executor, sequence-scheduler)
- **webhooks/** - Inbound webhooks:
  - `ses` - SES/SNS bounce, complaint, and delivery events
  - `targets` - Single target ingestion
  - `targets/bulk` - Bulk target ingestion
- **v1/** - REST API resources:
  - `agent` - Claude Managed Agents integration (sessions list, session events, instructions). Routes use the `withAgent` wrapper which resolves the per-org `agent_id` + `environment_id` and maps `AgentError` to HTTP responses.
  - `analytics` - Usage analytics
  - `campaigns` - Campaign management
  - `content` - Email content/templates (`generate`, `generate-to-outbox` also use `withAgent`)
  - `design-templates` - Email design templates
  - `graduation-rules` - Target graduation rules
  - `organization` - Organization settings (GET / PATCH, including `agent_id` and `environment_id`; 409 on duplicate `agent_id`)
  - `outbox` - Email outbox
  - `segments` - Audience segments
  - `send` - Email sending
  - `sequences` - Multi-step sequences
  - `setup` - Organization setup (returns `agent_configured`; legacy `twin_configured` alias kept for one release)
  - `target-types` - Target type definitions
  - `targets` - Target management
- **twin/[...path]** - 410 Gone catch-all. Returns RFC 9457 Problem Detail pointing clients at `/api/v1/agent/*`. Kept for one release as a migration aid.

### Other Routes
- **/.well-known/** - OAuth authorization server and protected resource metadata
- **/mcp** - MCP endpoint (15 tools for AI agents)

### Database
PostgreSQL (Neon) with `@neondatabase/serverless`. Query modules in `lib/queries/` handle database operations. Migrations are SQL files in `migrations/` numbered sequentially from `000_`.

Claude Managed Agents columns on `organizations`:
- `agent_id` (text, nullable, `UNIQUE`) — the Managed Agent that handles content generation for this org.
- `environment_id` (text, nullable) — the Managed Agents environment; falls back to `ANTHROPIC_DEFAULT_ENVIRONMENT_ID` when null.

Both are resolved together via `getAgentConfig(orgId)`, which returns `null` (treat as unconfigured → 503) when `agent_id` OR the resolved `environment_id` is missing. Auth is the deployment-wide `ANTHROPIC_API_KEY` (read by the SDK) — there is no per-org key.

### Lib Modules

**Core:**
- **lib/db.ts** - Neon database: `getDb()` (HTTP), `getPool()` (Pool), `sql` (tagged template proxy), `withTransaction()`
- **lib/env.ts** - Lazy `getEnv()` with Zod validation
- **lib/utils.ts** - `cn()` and `jsonResponse()` helpers
- **lib/schemas.ts** - Zod v3 request/response schemas

**Auth:**
- **lib/oauth.ts** - Server-side OAuth 2.1, JWT signing/verification with jose
- **lib/oauth-html.ts** - OAuth HTML page templates
- **lib/admin-auth.ts** - `requireAdmin()` + `isErrorResponse()` auth guard pattern
- **lib/auth-client.ts** - Client-side OAuth PKCE flow
- **lib/auth-context.tsx** - React auth context provider
- **lib/webhook-auth.ts** - Webhook secret verification (timing-safe compare)
- **lib/cron-utils.ts** - Cron secret verification

**Integrations:**
- **lib/ses.ts** - AWS SES v2 email delivery
- **lib/sns-verify.ts** - SNS signature verification for webhook events
- **lib/agent-session.ts** - Claude Managed Agents client (`@anthropic-ai/sdk`, `client.beta.sessions`). `runAgentSession`/`runAgentJson` create a session, open the SSE stream **before** sending the structured-goal `user.message`, accumulate `agent.message` text, and stop on `session.status_idle`. Output is content-seek extracted (newest message parsing to `{body}`/`{subject,body}`). `harvestAgentSession` resumes an inflight session (crash-resume); `onSessionCreated` persists the session id before the billed turn. Also `listAgentSessions` / `getAgentSessionEvents` (fail-closed IDOR via `session.agent.id`) / `getAgentInstructions` / `updateAgentInstructions` for the settings routes. `AgentError` carries `{ status, detail }`; upstream 401/403 → 502. The SDK's `maxRetries` covers 429/5xx.
- **lib/mcp-tools.ts** - MCP tool definitions (15 tools). MCP tools resolve `getAgentConfig(orgId)` and pass `agentId` + `environmentId` to the agent client.
- **lib/api.ts** - Client-side API client. `request()` reads `error.error → error.detail → error.message` in order. `formatApiError(err)` is the canonical client-side error formatter.

**Email & Content:**
- **lib/block-compiler.ts** - Email builder block compiler (blocks → HTML)
- **lib/template-engine.ts** - Variable template replacement ({{variable}} syntax)
- **lib/personalization.ts** - AI content personalization
- **lib/email.ts** - Email utilities
- **lib/graduation.ts** - Target graduation rule engine
- **lib/phone.ts** - Phone number utilities

### Query Modules (lib/queries/)
One module per resource: analytics, campaigns, content, design-templates, graduation, oauth, organization, outbox, segments, sequences, system, target-types, targets.

### Frontend
- **Next.js 16 App Router** with `(admin)` route group for protected pages
- **React 19** with **Tailwind 4** and shadcn/ui components
- **Tiptap** rich text editor for email content
- **Recharts** for analytics charts
- **dnd-kit** for drag-and-drop in sequence builder
- **Zustand** for client-side state management
- **Zod** for validation
- Custom `email-builder` component for visual email editing
- Custom `sequence-builder` component for drag-and-drop sequence editing

### External Integrations
- **Claude Managed Agents** (`lib/agent-session.ts`) - AI agent service for content personalization. Each org configures an `agent_id` (required) + `environment_id` (falls back to `ANTHROPIC_DEFAULT_ENVIRONMENT_ID`); auth is the deployment-wide `ANTHROPIC_API_KEY`. Settings UI: `/settings?tab=instructions` ("Agent" tab).
- **AWS SES** - Email delivery with SNS event webhooks (`lib/ses.ts`, `lib/sns-verify.ts`)
- **Neon** - Serverless PostgreSQL database (`lib/db.ts`)

## Key Patterns

### Auth Guard Pattern (matches Pundit)
```typescript
const auth = await requireAdmin(request);
if (isErrorResponse(auth)) return auth;
// auth.tenantId is available
```

### Agent Route Wrapper
Any route that talks to the AI agent should use `withAgent` — it handles auth, resolves the org's `agent_id` + `environment_id` via `getAgentConfig`, returns 503 when the org isn't configured, keeps `auth` in the context (the instructions PUT needs it for the audit row), and maps `AgentError` to the correct HTTP status (401/403 → 502):
```typescript
import { withAgent } from "@/app/api/v1/agent/_helpers";
import { listAgentSessions } from "@/lib/agent-session";

export async function GET(request: Request) {
  return withAgent(request, async ({ agentId, environmentId, tenantId }) => {
    const sessions = await listAgentSessions(agentId, { limit: 50 });
    return jsonResponse({ sessions });
  });
}
```

### Environment Variables
Uses `getEnv()` with Zod validation. All vars defined in `lib/env.ts`.

**Required:**
- `DATABASE_URL` - Neon connection string
- `JWT_SECRET` - JWT signing key (min 32 chars)
- `NEXT_PUBLIC_URL` - App URL
- `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY` - SES credentials (avoids Vercel reserved var conflict)
- `ANTHROPIC_API_KEY` - Deployment-wide key for the Anthropic account that owns the Managed Agents. Per-org `agent_id` + `environment_id` live on `organizations` (Settings → Agent). `ANTHROPIC_DEFAULT_ENVIRONMENT_ID` is the fallback environment, **required outside `ENVIRONMENT=dev`**.

**Required in production/staging:**
- `CRON_SECRET` - Vercel cron auth (unauthenticated cron only allowed in dev)

**Optional:**
- `SES_NOTIFICATION_TOPIC_ARN` - SNS topic for SES events

**With defaults:**
- `ENVIRONMENT` - "dev" | "staging" | "prod" (default: "dev")
- `AWS_SES_REGION` - SES region (default: "us-east-1")
- `ALLOWED_DCR_DOMAINS` - Comma-separated allowed domains for DCR (default: "claude.ai,chatgpt.com,localhost,127.0.0.1")

### Zod Schemas
All API request/response models in `lib/schemas.ts`. Uses Zod v3.

### Adding New API Endpoints
1. Create route file in `app/api/v1/<resource>/route.ts`
2. Add schemas to `lib/schemas.ts`
3. Add query functions to `lib/queries/` if needed
4. Use `requireAdmin` + `isErrorResponse` auth pattern

### Adding Database Migrations
Create new file in `migrations/` with next sequential number (e.g., `043_description.sql`). Run with `npx tsx scripts/migrate.ts`. `RENAME COLUMN` is not idempotent in PG — wrap renames in a `DO` block with an `information_schema.columns` check if the migration could be replayed.

### Database Queries
Use tagged template `sql` for static queries, `getPool().query()` for dynamic queries:
```typescript
import { sql } from '@/lib/db';
const rows = await sql`SELECT * FROM targets WHERE organization_id = ${orgId}`;
```

### Tenant Isolation
Every query must include explicit `WHERE organization_id = ${orgId}`. No RLS.

### Testing
- Test runner: Vitest 4 (`npm test`). Default env is `node`; component tests use `// @vitest-environment jsdom` per file.
- Mocks: `vi.mock("@/lib/db", () => ({ sql: Object.assign(vi.fn(), { query: vi.fn() }) }))` is the standard pattern for query tests. Routes that go through `withAgent` also need `vi.mock("@/lib/queries/organization", () => ({ getAgentConfig: vi.fn() }))`.
- External HTTP: `test/helpers/fetch.ts:mockFetchQueue([...])` stubs `globalThis.fetch` with a queue of canned responses and records each call for assertions.
- Env: `test/setup.ts` provides sane defaults (`ANTHROPIC_API_KEY`, `ANTHROPIC_DEFAULT_ENVIRONMENT_ID`, `DATABASE_URL`, etc.) so tests run without a real `.env.local`. Mock the SDK with `vi.mock("@anthropic-ai/sdk")` for client/route tests.
- When changing a signature, search `test/**` for callers — assertions using `toHaveBeenCalledWith` are positional and will fail on added args like `environmentId`.

### Per-Org Agent Config
When writing new code that calls the agent, resolve `getAgentConfig(orgId)` and pass `agentId` + `environmentId`:
```typescript
async function doThing(orgId: string) {
  const config = await getAgentConfig(orgId); // { agentId, environmentId } | null
  if (!config) return; // not configured (agent_id or environment_id missing)
  await runAgentJson(config.agentId, config.environmentId, JSON.stringify(goal));
}
```
Inside a route handler, prefer `withAgent` (it resolves both and surfaces `{ agentId, environmentId, tenantId, auth }`). Inside a cron job, read `agent_id` and `environment_id` directly off the joined row from `getDueEnrollments` / `claimScheduledCampaigns` (env-default fallback for `environment_id`).

<!-- headroom:learn:start -->
## Headroom Learned Patterns
*Auto-generated by `headroom learn` on 2026-06-15 — do not edit manually*

### File Paths
*~1,200 tokens/session saved*
Repo root is `/Users/marmarko/code/envoy`. Code-review/diff prompts list files as repo-relative paths — Read them as-is (relative) or prefixed with the repo root. NEVER Read `/home/user/...`, `/home/user/repo/...`, `/repo`, bare `/lib/...`, `/proxy.ts`, or other users' home dirs (`/Users/jesse`, `/Users/jameswalker`) — they 404 and waste a retry every time.

### Large Files
*~700 tokens/session saved*
`lib/mcp-tools.ts` is large (~35KB) — grep or Read with offset before reading whole. `lib/agent-session.ts`, `lib/api.ts`, `lib/twin.ts` are also 16-25KB.

### Commands
*~600 tokens/session saved*
Test: `npx vitest run [path]` or `npm test`. Typecheck: `npx tsc --noEmit`. Build: `npx next build`. On stale Next type errors (`'page' implicitly has type any`, etc.), `rm -rf .next/types` before rebuild. Import alias `@/` maps to repo root.

### Deploy & DB
*~500 tokens/session saved*
Prod: https://envoy-sigma.vercel.app (Vercel project `envoy`, team `team_pA5mOmaSaEyo6YbSTxRstK6A`). DB: Neon via `neonctl` (project `restless-wind-31337764`, org `org-billowing-term-42296820`). Migrations are `migrations/NNN_*.sql`, applied via `scripts/migrate.ts`.

<!-- headroom:learn:end -->
