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
- **AI**: Twin (build.twin.so) agent service
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
  - `twin` - Twin AI agent integration (agent, runs, events, instructions). Routes use the `withTwinAgent` wrapper which resolves the per-org agent + API key and maps `TwinError` to HTTP responses.
  - `analytics` - Usage analytics
  - `campaigns` - Campaign management
  - `content` - Email content/templates (`generate`, `generate-to-outbox` also use `withTwinAgent`)
  - `design-templates` - Email design templates
  - `graduation-rules` - Target graduation rules
  - `organization` - Organization settings (GET / PATCH, including `twin_agent_id` and `twin_api_key`)
  - `outbox` - Email outbox
  - `segments` - Audience segments
  - `send` - Email sending
  - `sequences` - Multi-step sequences
  - `setup` - Organization setup (returns `twin_configured`; legacy `agentplane_configured` alias kept for one release)
  - `target-types` - Target type definitions
  - `targets` - Target management
- **agentplane/[...path]** - 410 Gone catch-all. Returns RFC 9457 Problem Detail pointing OAuth clients at `/api/v1/twin/*`. Kept for one release as a migration aid.

### Other Routes
- **/.well-known/** - OAuth authorization server and protected resource metadata
- **/mcp** - MCP endpoint (15 tools for AI agents)

### Database
PostgreSQL (Neon) with `@neondatabase/serverless`. Query modules in `lib/queries/` handle database operations. Migrations are SQL files in `migrations/` numbered `000_` through `042_` (43 files).

Twin integration columns on `organizations`:
- `twin_agent_id` (text, nullable) — the deployed Twin agent that handles content generation for this org. Resolved via `getTwinAgentId(orgId)`.
- `twin_api_key` (text, nullable) — per-org Twin API key override. Resolved via `resolveTwinApiKey(orgId)`, which falls back to the `TWIN_API_KEY` env var when null. **Never** SELECTed in `getOrganization`; the route surfaces a `twin_api_key_configured` boolean instead so the value never leaves the server.

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
- **lib/twin.ts** - Twin REST API client. Every public function accepts `TwinCallOpts { apiKey?: string }`; when unset, `twinFetch` falls back to `env.TWIN_API_KEY`. `runAgent` supports `existingRunId` for idempotent crash-resume. Retries on 5xx are gated to safe methods (GET/HEAD/OPTIONS); 429 always retries.
- **lib/mcp-tools.ts** - MCP tool definitions (15 tools). MCP tools resolve both `agentId` and `apiKey` via `lib/queries/organization` and pass `apiKey` to Twin calls.
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
- **Twin** (`lib/twin.ts`) - AI agent service for content personalization. Each org configures a `twin_agent_id` (required for AI features) and optionally a `twin_api_key` override; absent that, the deployment-wide `TWIN_API_KEY` env var is used. Settings UI: `/settings?tab=instructions` ("Twin agent" tab).
- **AWS SES** - Email delivery with SNS event webhooks (`lib/ses.ts`, `lib/sns-verify.ts`)
- **Neon** - Serverless PostgreSQL database (`lib/db.ts`)

## Key Patterns

### Auth Guard Pattern (matches Pundit)
```typescript
const auth = await requireAdmin(request);
if (isErrorResponse(auth)) return auth;
// auth.tenantId is available
```

### Twin Route Wrapper
Any route that talks to Twin should use `withTwinAgent` — it handles auth, resolves the org's `twin_agent_id` + `twin_api_key`, returns 503 when the org isn't configured, and maps `TwinError` to the correct HTTP status:
```typescript
import { withTwinAgent } from "@/app/api/v1/twin/_helpers";
import * as twin from "@/lib/twin";

export async function GET(request: Request) {
  return withTwinAgent(request, async ({ agentId, apiKey, tenantId }) => {
    const agent = await twin.getAgent(agentId, { apiKey });
    return jsonResponse({ agent });
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
- `TWIN_API_KEY` - Deployment-wide Twin API key fallback. Each organization may override it per-row via `organizations.twin_api_key` (Settings → Twin agent → Twin API key). `TWIN_API_URL` defaults to `https://build.twin.so` and is optional. Must be `https://` outside `ENVIRONMENT=dev`.

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
- Mocks: `vi.mock("@/lib/db", () => ({ sql: Object.assign(vi.fn(), { query: vi.fn() }) }))` is the standard pattern for query tests. Routes that go through `withTwinAgent` also need `vi.mock("@/lib/queries/organization", () => ({ getTwinAgentId: vi.fn(), resolveTwinApiKey: vi.fn() }))`.
- External HTTP: `test/helpers/fetch.ts:mockFetchQueue([...])` stubs `globalThis.fetch` with a queue of canned responses and records each call for assertions.
- Env: `test/setup.ts` provides sane defaults (`TWIN_API_KEY`, `DATABASE_URL`, etc.) so tests run without a real `.env.local`.
- When changing a signature, search `test/**` for callers — assertions using `toHaveBeenCalledWith` are positional and will fail on added options like `apiKey`.

### Per-Org Twin API Key
When writing new code that calls Twin, accept and forward `apiKey` through `TwinCallOpts` so per-org overrides keep working:
```typescript
async function doThing(orgId: string) {
  const apiKey = await resolveTwinApiKey(orgId); // env-var fallback inside
  const agentId = await getTwinAgentId(orgId);
  if (!agentId) return; // not configured
  await twin.startRun(agentId, { userMessage: "...", apiKey });
}
```
Inside a route handler, prefer `withTwinAgent` (it resolves both for you and surfaces `{ agentId, apiKey, tenantId }`). Inside a cron job, read `twin_agent_id` and `twin_api_key` directly off the joined row from `getDueEnrollments` / `claimScheduledCampaigns`.
