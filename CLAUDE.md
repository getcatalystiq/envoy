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
- **AI**: AgentPlane agent service
- **Auth**: OAuth 2.1 with PKCE, JWT via jose
- **MCP**: `mcp-handler` for AI agent integration

### Project Structure
- **app/** - Next.js App Router (pages, API routes, cron jobs)
- **components/** - React components (ui, email-builder, sequence-builder, landing, settings)
- **lib/** - Shared TypeScript modules (db, auth, queries, integrations)
- **lib/queries/** - Database query modules (one per resource)
- **migrations/** - PostgreSQL migration files (numbered sequentially)
- **scripts/** - Utility scripts (migrate.ts, setup.ts)

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
  - `agentplane` - AgentPlane AI agent integration
  - `analytics` - Usage analytics
  - `campaigns` - Campaign management
  - `content` - Email content/templates
  - `design-templates` - Email design templates
  - `graduation-rules` - Target graduation rules
  - `organization` - Organization settings
  - `outbox` - Email outbox
  - `segments` - Audience segments
  - `send` - Email sending
  - `sequences` - Multi-step sequences
  - `setup` - Organization setup
  - `target-types` - Target type definitions
  - `targets` - Target management

### Other Routes
- **/.well-known/** - OAuth authorization server and protected resource metadata
- **/mcp** - MCP endpoint (15 tools for AI agents)

### Database
PostgreSQL (Neon) with `@neondatabase/serverless`. Query modules in `lib/queries/` handle database operations. Migrations are SQL files in `migrations/` numbered `000_` through `037_` (38 files).

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
- **lib/agentplane.ts** - AgentPlane AI agent client
- **lib/mcp-tools.ts** - MCP tool definitions (15 tools)
- **lib/api.ts** - Client-side API client with types

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
- **AgentPlane** - AI agent service for content personalization (`lib/agentplane.ts`)
- **AWS SES** - Email delivery with SNS event webhooks (`lib/ses.ts`, `lib/sns-verify.ts`)
- **Neon** - Serverless PostgreSQL database (`lib/db.ts`)

## Key Patterns

### Auth Guard Pattern (matches Pundit)
```typescript
const auth = await requireAdmin(request);
if (isErrorResponse(auth)) return auth;
// auth.tenantId is available
```

### Environment Variables
Uses `getEnv()` with Zod validation. All vars defined in `lib/env.ts`.

**Required:**
- `DATABASE_URL` - Neon connection string
- `JWT_SECRET` - JWT signing key (min 32 chars)
- `NEXT_PUBLIC_URL` - App URL
- `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY` - SES credentials (avoids Vercel reserved var conflict)
- `AGENTPLANE_API_URL` / `AGENTPLANE_API_KEY` - AgentPlane credentials

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
Create new file in `migrations/` with next sequential number (e.g., `038_description.sql`). Run with `npx tsx scripts/migrate.ts`.

### Database Queries
Use tagged template `sql` for static queries, `getPool().query()` for dynamic queries:
```typescript
import { sql } from '@/lib/db';
const rows = await sql`SELECT * FROM targets WHERE organization_id = ${orgId}`;
```

### Tenant Isolation
Every query must include explicit `WHERE organization_id = ${orgId}`. No RLS.
