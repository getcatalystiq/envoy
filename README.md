# Envoy

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Drip campaigns that write themselves. Build multi-step email sequences where every message is AI-personalized to each recipient. Envoy researches your prospects and writes unique follow-ups that convert.

Open source. Self-host or deploy to Vercel in minutes.

## Features

- **Multi-Step Sequences** - Build drip campaigns with multiple steps, delays, and conditions. Drag and drop to design your ideal follow-up flow.
- **AI-Personalized at Every Step** - Each email in the sequence is uniquely written for the recipient using AI that researches their role, company, and context.
- **Automated Scheduling** - Set delays between steps and let Envoy handle the timing. Sequences run on autopilot so you never miss a follow-up.
- **Engagement Tracking** - Track opens, clicks, bounces, and complaints across every step. See which messages in your sequence perform best.
- **Lifecycle Graduation** - Automatically advance targets through lifecycle stages as they engage. Stop emailing prospects who already converted.
- **Visual Email Builder** - Design emails with a block-based editor. Add AI personalization to individual blocks for fine-grained control.
- **MCP Server** - 15-tool MCP endpoint so AI agents can operate Envoy directly.
- **OAuth 2.1** - Full OAuth 2.1 provider with PKCE, Dynamic Client Registration, and JWT.

## How It Works

1. **Import Your Targets** - Upload prospects via CSV, webhook, or the API. Envoy stores their details and segments them by type.
2. **Build a Sequence** - Design a multi-step drip campaign with the drag-and-drop sequence builder. Set delays and conditions between steps.
3. **AI Writes Each Email** - For every target at every step, AI generates a unique email personalized to their role, company, and context.
4. **Drip on Autopilot** - Envoy sends emails on schedule, tracks engagement, and graduates targets through lifecycle stages automatically.

## Tech Stack

- **Next.js 16** (App Router, Turbopack) on **Vercel**
- **TypeScript 5.9**, **React 19**, **Tailwind 4**
- **PostgreSQL** (Neon serverless)
- **AWS SES v2** for email delivery with SNS event webhooks
- **AgentPlane** for AI content personalization
- **Tiptap** rich text editor, **Recharts** charts, **dnd-kit** drag-and-drop

## Getting Started

```bash
git clone https://github.com/getcatalystiq/envoy.git
cd envoy
cp .env.example .env.local   # fill in your values
npm install
npm run migrate              # run database migrations
npm run setup                # create organization + admin user
npm run dev                  # starts at http://localhost:3000
```

See [`.env.example`](.env.example) for all configuration options.

### Prerequisites

- Node.js 18+
- PostgreSQL database ([Neon](https://neon.tech) recommended)
- AWS SES account for email delivery
- [AgentPlane](https://agentplane.vercel.app) account for AI personalization (optional)

## Project Structure

```
app/
  (admin)/          Protected admin pages (dashboard, targets, campaigns, etc.)
  api/
    auth/           Login/signup
    health/         Health check
    oauth/          OAuth 2.1 endpoints
    cron/           Scheduled jobs (email-sender, campaign-executor, sequence-scheduler)
    webhooks/       SES events, target ingestion
    v1/             REST API (14 resources)
  mcp/              MCP server endpoint
  .well-known/      OAuth metadata
components/
  ui/               shadcn/ui components
  email-builder/    Visual block-based email editor
  sequence-builder/ Drag-and-drop sequence editor
  landing/          Landing page components
  settings/         Settings page components
lib/
  queries/          Database query modules (one per resource)
  db.ts             Neon database client
  schemas.ts        Zod request/response schemas
  mcp-tools.ts      MCP tool definitions
  ses.ts            AWS SES email delivery
  agentplane.ts     AgentPlane AI client
  oauth.ts          OAuth 2.1 server
migrations/         Sequential SQL migration files
```

## API

### REST API (`/api/v1/`)

All endpoints require OAuth 2.1 bearer token authentication. Resources: agentplane, analytics, campaigns, content, design-templates, graduation-rules, organization, outbox, segments, send, sequences, setup, target-types, targets.

### MCP Endpoint (`/mcp`)

15 tools for AI agents: search/manage targets, generate personalized content, manage campaigns, view analytics, manage outbox, view sequence status, and configure AI personalization.

### Webhooks (`/api/webhooks/`)

- `POST /api/webhooks/ses` - SES/SNS bounce, complaint, and delivery events
- `POST /api/webhooks/targets` - Single target ingestion (requires webhook secret)
- `POST /api/webhooks/targets/bulk` - Bulk target ingestion

## Deployment

### 1. Database (Neon)

1. Create a project at [neon.tech](https://neon.tech)
2. Copy the connection string — this is your `DATABASE_URL`
3. Run migrations and create your admin account:
   ```bash
   DATABASE_URL="postgresql://..." npm run migrate
   DATABASE_URL="postgresql://..." npm run setup
   ```

### 2. Vercel

1. Fork this repo and import it into [Vercel](https://vercel.com/new)
2. Add environment variables in the Vercel dashboard (Settings > Environment Variables):

   | Variable | Value |
   |----------|-------|
   | `DATABASE_URL` | Neon connection string |
   | `JWT_SECRET` | Random string, min 32 chars (e.g., `openssl rand -hex 32`) |
   | `NEXT_PUBLIC_URL` | Your Vercel deployment URL (e.g., `https://your-app.vercel.app`) |
   | `SES_ACCESS_KEY_ID` | AWS IAM access key (see step 3) |
   | `SES_SECRET_ACCESS_KEY` | AWS IAM secret key |
   | `AGENTPLANE_API_URL` | AgentPlane service URL |
   | `AGENTPLANE_API_KEY` | AgentPlane API key |
   | `CRON_SECRET` | Random string for cron auth (e.g., `openssl rand -hex 16`) |

3. Deploy. Vercel will build and start serving the app.
4. The cron jobs defined in `vercel.json` will activate automatically:
   - **email-sender** — every minute, sends queued emails from the outbox
   - **sequence-scheduler** — every 5 minutes, enrolls targets in sequences and advances steps
   - **campaign-executor** — every 10 minutes, processes scheduled campaigns

### 3. AWS SES

SES is used for sending emails and receiving delivery/bounce/complaint notifications.

#### IAM User

1. Create an IAM user (or use an existing one) with the following permissions:
   - `ses:SendEmail`
   - `ses:CreateEmailIdentity`
   - `ses:GetEmailIdentity`
   - `ses:GetAccount`
   - `ses:CreateConfigurationSet`
   - `ses:CreateConfigurationSetEventDestination`
   - `ses:DeleteConfigurationSetEventDestination`
2. Create an access key and add `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY` to Vercel

#### Domain Verification

1. In the Envoy UI, go to **Settings** and enter your sending domain
2. Envoy will call the SES API to create an email identity and return DKIM DNS records
3. Add the 3 CNAME records to your domain's DNS
4. Click **Verify** in Settings — once DNS propagates, the domain will show as verified
5. Envoy automatically creates an SES Configuration Set for your organization

#### Event Notifications (bounces, deliveries, complaints)

To track email delivery status, set up the SES → SNS → Webhook pipeline:

1. Create an SNS topic:
   ```bash
   aws sns create-topic --name envoy-ses-notifications --region us-east-1
   ```

2. Add the topic ARN to Vercel as `SES_NOTIFICATION_TOPIC_ARN`

3. Run the setup script to wire everything together:
   ```bash
   SNS_TOPIC_ARN="arn:aws:sns:us-east-1:YOUR_ACCOUNT_ID:envoy-ses-notifications" \
   WEBHOOK_URL="https://your-app.vercel.app/api/webhooks/ses" \
   ./scripts/setup-ses-sns.sh
   ```

   This script:
   - Sets the SNS topic policy to allow SES to publish
   - Subscribes your Vercel webhook URL to the topic (auto-confirmed by the app)
   - Configures SES configuration sets to forward events to SNS

4. Verify it works: send a test email through Envoy and check that the `email_sends` table status progresses from `sent` → `delivered`

> **Note:** SES starts in sandbox mode, which limits you to verified email addresses only. [Request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) when ready to send to real recipients.

### 4. AgentPlane (optional)

AgentPlane provides AI-powered content personalization. Without it, emails send without AI personalization.

1. Sign up at [agentplane.vercel.app](https://agentplane.vercel.app)
2. Create a tenant and agent
3. Add `AGENTPLANE_API_URL` and `AGENTPLANE_API_KEY` to Vercel

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Security

See [SECURITY.md](SECURITY.md) for our security policy and how to report vulnerabilities.

## License

[MIT](LICENSE)
