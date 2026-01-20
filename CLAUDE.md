# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Envoy is an AI-powered sales and marketing agent platform. It enables organizations to create email campaigns with AI-driven personalization, manage target audiences, and automate multi-step email sequences.

## Development Commands

### Local Development Setup
```bash
# Full setup (installs deps, opens terminal windows for all services)
./scripts/setup-local.sh --terminal

# Quick restart (skip dependency installation)
./scripts/setup-local.sh --skip-deps --terminal

# With Warp terminal
./scripts/setup-local.sh --terminal --warp
```

### Running Services Individually
```bash
# Frontend (port 3000)
cd admin-ui && npm run dev

# Backend API (port 8000) - requires DB tunnel or local Postgres
./scripts/local-dev.sh

# DB tunnel to dev Aurora (port 5433)
./scripts/db-tunnel.sh dev 5433
```

### Testing
```bash
# Run all tests
pytest

# Run specific test file
pytest tests/unit/test_schemas.py

# Run with coverage
pytest --cov
```

### QA
Use agent-browser skill to automate browser interactions for web testing, form filling, screenshots, and data extraction. Use -headed mode by default.

### Linting & Type Checking
```bash
# Python linting
ruff check .
ruff check --fix .

# Python type checking
mypy functions/ layers/

# Frontend type checking
cd admin-ui && npm run build  # TypeScript is checked during build
```

### Deployment
```bash
# Deploy to dev (default)
./scripts/deploy.sh

# Deploy to staging
./scripts/deploy.sh staging

# Deploy to prod
./scripts/deploy.sh prod
```

The deploy script handles the full deployment pipeline:
1. Syncs migrations to Lambda function
2. Installs shared layer dependencies
3. Builds SAM application
4. Deploys backend to AWS
5. Builds and deploys frontend to S3
6. Invalidates CloudFront cache

## Architecture

### Monorepo Structure
- **admin-ui/** - React/TypeScript frontend (Vite, Tailwind, Radix UI)
- **functions/** - AWS Lambda functions (Python/FastAPI)
- **layers/shared/** - Shared Python code used across Lambda functions
- **migrations/** - PostgreSQL migration files (numbered sequentially)
- **plans/** - Feature design documents and implementation specs

### Lambda Functions
| Function | Purpose |
|----------|---------|
| api | Main FastAPI application (all REST endpoints) |
| campaign_executor | Executes scheduled campaigns |
| email_scheduler | Processes email queue and sends via SES |
| sequence_scheduler | Advances enrollments through sequence steps |
| message_sender | Individual message sending |
| webhook | Handles inbound webhooks |
| migration | Database migration runner |

### API Structure
- OAuth: `/.well-known/*`, `/oauth/*`
- Auth: `/auth/*`
- All resources: `/api/v1/{resource}` (targets, campaigns, sequences, content, etc.)
- MCP tools: `/mcp/*`

### Database
PostgreSQL (Aurora Serverless v2) with asyncpg. Query classes in `layers/shared/shared/queries/` handle database operations. Migrations are SQL files in `migrations/` numbered `000_` through `026_`.

### Frontend State Management
- **Zustand** for global state
- **React Router** for navigation
- **Zod** for validation
- Custom `email-builder` component for MJML email editing
- Custom `sequence-builder` component for drag-and-drop sequence editing

### External Integrations
- **Maven** - AI personalization service (`layers/shared/shared/maven_client.py`)
- **AWS SES** - Email delivery (`layers/shared/shared/ses_client.py`)
- **AWS Secrets Manager** - Credentials storage

## Key Patterns

### Python Path for Local Dev
When running Python code locally, include shared layer:
```bash
PYTHONPATH="layers/shared:functions/api"
```

### Environment Variables
Local dev uses:
- `AURORA_HOST=localhost`, `AURORA_PORT=5433` (via tunnel)
- `AURORA_SECRET_ARN=envoy-dev-aurora-credentials`
- `JWT_PUBLIC_KEY=""` (disabled for local)

### Pydantic Schemas
All API request/response models are in `functions/api/app/schemas.py`. Use Pydantic v2 patterns.

### Adding New API Endpoints
1. Create/update router in `functions/api/app/routers/`
2. Add schemas to `functions/api/app/schemas.py`
3. Add query class to `layers/shared/shared/queries/` if needed
4. Register router in `functions/api/app/main.py`

### Adding Database Migrations
Create new file in `migrations/` with next sequential number (e.g., `027_description.sql`). Migrations run automatically during deployment via the migration Lambda.
