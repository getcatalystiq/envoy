---
title: "refactor: Migrate Maven to AgentPlane and Remove Maven Completely"
type: refactor
status: completed
date: 2026-02-17
deepened: 2026-02-17
---

# refactor: Migrate Maven to AgentPlane and Remove Maven Completely

## Enhancement Summary

**Deepened on:** 2026-02-17
**Research agents used:** 5 (async httpx/NDJSON streaming, FastAPI migration, React/frontend patterns, DB migration safety, architecture/security review)

### Key Improvements
1. **Direct cutover** -- No feature flags or backward compatibility needed. Clean replacement of Maven with AgentPlane.
2. **Security hardening** -- API key moved from env vars to Secrets Manager. OAuth `postMessage` origin validation added. Tenant isolation concerns documented.
3. **NDJSON streaming implementation** -- Concrete `aiter_lines()` pattern with retry logic, error handling, and Lambda-specific timeout configuration.
4. **Migration safety** -- `SET LOCAL lock_timeout = '5s'` added, expand/contract pattern for column drops, backup table before removal.
5. **Missing dependency discovered** -- `functions/api/app/routers/mcp.py` also depends on `MavenDep` (6+ references). Must be migrated alongside or immediately after the main router.

### Critical Risks Identified
- VPC infrastructure is entangled with Maven naming (subnets, security groups, DB subnet group in `template.yaml`)
- Single API key for all orgs is a tenant isolation regression vs per-org SigV4
- `EmbeddedApp.tsx` has pre-existing `postMessage('*')` vulnerability

---

## Overview

Envoy currently uses Maven (Bedrock AgentCore) as its AI agent backend for three concerns:

1. **Skills management** (CRUD, file editing, publish) via `/api/v1/maven/skills`
2. **Connectors** (OAuth, connect/disconnect) via `/api/v1/maven/connectors`
3. **AI Activity** (invocation history, transcripts) via `/api/v1/maven/invocations`
4. **Runtime AI invocations** (content generation, stage assessment) called from Lambda functions

We are replacing Maven with **AgentPlane** for all of these and removing Maven entirely. Each Envoy organization maps to an AgentPlane tenant + agent.

## Problem Statement / Motivation

Maven is being sunset in favor of AgentPlane. All three Settings tabs (Skills, Connectors, AI Activity) and the underlying runtime need to be migrated. The goal is zero Maven references remaining in the codebase.

## Proposed Solution

### Architecture

- **Auth**: Single `AGENTPLANE_API_KEY` (admin-level Bearer token) stored in **AWS Secrets Manager** (not env var -- see Security Insights below)
- **Mapping**: Each org has `agentplane_tenant_id` + `agentplane_agent_id` columns
- **Client**: New `AgentPlaneClient` using `httpx` with Bearer auth (replaces `MavenClient` which used AWS SigV4)
- **Router**: New `/api/v1/agentplane` router (replaces `/api/v1/maven`)

#### Research Insights: Architecture

**Security Concerns with Single API Key:**
- Maven used per-org SigV4 (IAM-based, per-request signing). A single Bearer token for all orgs is a tenant isolation regression.
- If the key is compromised, *every* org's AI operations are exposed.
- Investigate whether AgentPlane supports per-tenant API keys. If so, store per-org in the database alongside `agentplane_tenant_id`.
- If single key is unavoidable, validate org-tenant mapping server-side before every call and log every cross-boundary request.

**API Key Storage:**
- Lambda env vars are visible in AWS Console, CloudFormation outputs, and crash dumps.
- The infrastructure already has `secretsmanager:GetSecretValue` IAM policies (template.yaml line 229-234).
- Store in Secrets Manager, fetch at cold start, cache in module-level variable:

```python
_agentplane_key: str | None = None

async def get_agentplane_key() -> str:
    global _agentplane_key
    if _agentplane_key is None:
        _agentplane_key = await fetch_secret("envoy-agentplane-api-key")
    return _agentplane_key
```

**VPC / Networking:**
- VPC infrastructure will keep its Maven naming (cosmetic only, no functional impact).
- AgentPlane is external HTTPS. Lambdas in private VPC need NAT Gateway for outbound access. Verify NAT Gateway exists and routes are configured.

### Skills Model Mapping

| Maven Skill | AgentPlane Skill | Notes |
|-------------|-----------------|-------|
| `id` | (implicit - folder name) | AgentPlane uses folder as identifier |
| `name` | `folder` | Folder name serves as skill name |
| `slug` | `folder` | Same |
| `description` | File content (e.g. in SKILL.md) | No dedicated field |
| `prompt` | File content (e.g. SKILL.md) | Stored as file |
| `enabled` | Presence in array | Add = enable, remove = disable |
| File operations | Direct array mutation | PATCH agent with updated skills array |
| Publish workflow | N/A (immediate) | No draft/publish - saves are live |

### Connector Model Mapping

| Maven Connector | AgentPlane Connector | Notes |
|-----------------|---------------------|-------|
| `id` | `slug` | Composio toolkit slug |
| `name` | `name` | From Composio toolkit metadata |
| `connected` | `connectionStatus === 'ACTIVE'` | Richer status model |
| `requires_oauth` | `authScheme` | OAUTH2, API_KEY, NO_AUTH |
| Service OAuth | Agent-scoped OAuth | Per-agent instead of per-service |

### Activity Model Mapping

| Maven Invocation | AgentPlane Run | Notes |
|-----------------|---------------|-------|
| `session_id` | `id` (run ID) | UUID |
| `last_modified` | `created_at` | |
| `size` | N/A | Replaced by cost/turns/duration |
| Messages array | Transcript (NDJSON) | Different format: stream events |
| Tool calls on messages | `tool_use` / `tool_result` events | Separate events in transcript |

---

## Implementation Phases

### Phase 1: Database + AgentPlane Client

#### 1a. Migration `033_agentplane_columns.sql`

```sql
-- Migration: 033_agentplane_columns.sql
-- Add AgentPlane tenant and agent ID columns to organizations

SET LOCAL lock_timeout = '5s';

ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS agentplane_tenant_id TEXT,
ADD COLUMN IF NOT EXISTS agentplane_agent_id TEXT;
```

#### Research Insights: Database Migration

**Why this is safe:**
- Adding nullable columns without DEFAULT is a metadata-only operation in PostgreSQL 11+. No table rewrite, completes in milliseconds.
- `IF NOT EXISTS` is consistent with existing patterns (migrations 008, 018, 026) and makes the migration idempotent.
- The `organizations` table is small (one row per org), so even worst-case scenarios are trivial.

**`SET LOCAL lock_timeout = '5s'`:**
- Prevents lock queue pileup. If the lock can't be acquired in 5s, the statement fails instead of blocking all subsequent queries.
- This is a best practice from [PostgresAI zero-downtime migrations](https://postgres.ai/blog/20210923-zero-downtime-postgres-schema-migrations-lock-timeout-and-retries).

**NOT NULL / Indexes -- not yet:**
- NOT NULL can't be added until all orgs are backfilled.
- A partial unique index is only needed if uniqueness must be enforced:

```sql
-- Add later after backfill:
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_agentplane_tenant
ON organizations(agentplane_tenant_id)
WHERE agentplane_tenant_id IS NOT NULL;
```

**Column naming: `agentplane_tenant_id` and `agentplane_agent_id` follow the established `{service}_{noun}_id` pattern** (matches `maven_tenant_id`, `ses_tenant_name`).

#### 1b. Environment Variables (`template.yaml`)

Add parameters:
```yaml
AgentPlaneAPIURL:
  Type: String
  Description: AgentPlane API base URL
AgentPlaneAPIKey:
  Type: String
  Description: AgentPlane admin API key
  NoEcho: true
```

Add to API function + all Lambda functions that currently use Maven:
```yaml
AGENTPLANE_API_URL: !Ref AgentPlaneAPIURL
AGENTPLANE_API_KEY: !Ref AgentPlaneAPIKey
```

> **Note:** The API key env var is a fallback; prefer Secrets Manager fetch at runtime (see 0b). The env var provides a migration path and is useful for local development.

#### 1c. AgentPlane Client (additive -- alongside MavenClient)

**File:** `layers/shared/shared/agentplane_client.py` (create)

```python
class AgentPlaneClient:
    def __init__(self, tenant_id: str, agent_id: str):
        self.tenant_id = tenant_id
        self.agent_id = agent_id
        self.base_url = os.environ["AGENTPLANE_API_URL"]
        self.api_key = os.environ["AGENTPLANE_API_KEY"]

    async def _request(self, method, path, body=None) -> dict:
        """Admin API request with Bearer auth."""
        ...

    # Skills (via Agent.skills array)
    async def list_skills(self) -> list[dict]
    async def get_skill(self, folder: str) -> dict
    async def create_skill(self, folder: str, files: list[dict]) -> dict
    async def update_skill(self, folder: str, files: list[dict]) -> dict
    async def delete_skill(self, folder: str) -> dict

    # Connectors
    async def list_connectors(self) -> list[dict]
    async def list_toolkits(self) -> list[dict]
    async def add_toolkits(self, slugs: list[str]) -> dict
    async def remove_toolkit(self, slug: str) -> dict
    async def save_api_key(self, toolkit: str, api_key: str) -> dict
    async def initiate_oauth(self, toolkit: str) -> dict

    # Runs / Activity
    async def list_runs(self, limit=50, offset=0, status=None) -> dict
    async def get_run(self, run_id: str) -> dict

    # Runtime invocation (replaces maven.invoke_skill)
    async def run_agent(self, prompt: str, max_turns=None, max_budget_usd=None) -> dict
```

#### Research Insights: httpx Client Implementation

**Connection management -- per-method `async with httpx.AsyncClient()`:**
- Matches existing MavenClient pattern. Each method creates its own client context.
- Safest for Lambda event loop lifecycle. A global httpx client can get `RuntimeError: Event loop is closed` between Lambda invocations.
- No connection pooling across requests, but this is acceptable for Lambda's invocation model.

**Timeout configuration -- fine-grained:**
```python
import httpx

# For long-running AI streaming operations
STREAMING_TIMEOUT = httpx.Timeout(
    connect=10.0,   # 10s -- Lambda VPC can have slow DNS/NAT
    read=300.0,     # 5 min -- matches existing Maven 300s timeout
    write=10.0,
    pool=10.0,
)

# For short admin/CRUD calls
ADMIN_TIMEOUT = httpx.Timeout(
    connect=10.0,
    read=30.0,
    write=10.0,
    pool=10.0,
)
```

**NDJSON streaming with `aiter_lines()`:**
```python
async def _consume_ndjson_stream(self, response: httpx.Response) -> RunResult:
    """Parse NDJSON stream and return the final result."""
    result: RunResult | None = None

    async for line in response.aiter_lines():
        line = line.strip()
        if not line:
            continue  # skip keepalives

        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            logger.warning("Skipping malformed NDJSON line: %s", line[:200])
            continue

        event_type = event.get("type")

        if event_type == "error":
            raise AgentPlaneError(
                message=event.get("data", {}).get("message", "Unknown error"),
                code=event.get("data", {}).get("code"),
            )

        if event_type == "result":
            result = RunResult(
                output=event.get("data", {}).get("output", ""),
                session_id=event.get("data", {}).get("session_id"),
                metadata=event.get("data", {}).get("metadata", {}),
            )
            # Continue draining to keep connection clean

    if result is None:
        raise AgentPlaneError("Stream ended without result event")
    return result
```

**Why `aiter_lines()` over `aiter_bytes()`:** `aiter_lines()` handles buffering across chunk boundaries. Raw bytes could split a JSON line across chunks, requiring manual buffering.

**Retry logic -- tenacity with smart filtering:**
```python
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

def _is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, httpx.ConnectError | httpx.ConnectTimeout | httpx.PoolTimeout):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code == 429 or exc.response.status_code >= 500
    return False

@retry(
    retry=retry_if_exception(_is_retryable),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    before_sleep=before_sleep_log(logger, logging.WARNING),
    reraise=True,
)
async def run_agent(self, prompt: str, ...) -> RunResult:
    ...
```

**Do NOT retry `ReadTimeout` on streaming:** A `ReadTimeout` during NDJSON streaming means the AI operation is legitimately slow, not transient. The 300s timeout is the correct approach.

**Error handling pattern (from most-specific to least-specific):**
- `HTTPStatusError` 429/5xx -> let tenacity retry
- `HTTPStatusError` 4xx -> wrap in `AgentPlaneError`
- `ConnectError/ConnectTimeout/PoolTimeout` -> let tenacity retry
- `ReadTimeout` -> wrap in `AgentPlaneError` with timeout context

**NDJSON memory safety:**
- Lambda has limited memory. If AgentPlane streams very large responses, implement a max buffer size (4MB).
- Consider a polling fallback: `POST /api/runs` to start, `GET /api/runs/{id}` to check status. More resilient to network interruptions.

**Admin API endpoint mapping:**

| Method | AgentPlane Endpoint | Purpose |
|--------|-------------------|---------|
| Skills list | `GET /api/admin/agents/{agentId}` -> extract `.skills` | |
| Skills update | `PATCH /api/admin/agents/{agentId}` with `{ skills: [...] }` | Whole-array update |
| Connectors list | `GET /api/admin/agents/{agentId}/connectors` | |
| Toolkits list | `GET /api/admin/composio/toolkits` | |
| Add toolkits | `PATCH /api/admin/agents/{agentId}` with updated `composio_toolkits` | |
| Save API key | `POST /api/admin/agents/{agentId}/connectors` with `{ toolkit, api_key }` | |
| OAuth initiate | `POST /api/admin/agents/{agentId}/connectors/{toolkit}/initiate-oauth` | New endpoint |
| List runs | `GET /api/admin/runs?tenant_id={tenantId}` | |
| Get run + transcript | `GET /api/admin/runs/{runId}` | Returns run + transcript array |
| Run agent | `POST /api/runs` (public API with tenant key) | Streaming NDJSON |

#### 1d. Dependency Injection

**File:** `functions/api/app/dependencies.py` (modify -- replace MavenDep with AgentPlaneDep)

```python
from shared.agentplane_client import AgentPlaneClient

async def get_agentplane_client(org_id: CurrentOrg, db: DBConnection) -> AgentPlaneClient:
    org = await db.fetchrow(
        "SELECT agentplane_tenant_id, agentplane_agent_id FROM organizations WHERE id = $1",
        org_id,
    )
    if not org or not org["agentplane_agent_id"]:
        raise HTTPException(status_code=503, detail="Organization not configured for AgentPlane")
    return AgentPlaneClient(
        tenant_id=org["agentplane_tenant_id"] or org_id,
        agent_id=org["agentplane_agent_id"],
    )

AgentPlaneDep = Annotated[AgentPlaneClient, Depends(get_agentplane_client)]
```

#### Research Insights: Dependency Injection

**Use `HTTPException(503)` instead of `ValueError`:**
- The current Maven code raises `ValueError("Organization not configured for Maven")` which becomes a generic 500.
- `503 Service Unavailable` with a clear message is more appropriate for "not yet configured".

**Files:**
- `migrations/033_agentplane_columns.sql` (create)
- `template.yaml` (modify - add params, add env vars to API/campaign_executor/email_scheduler/sequence_scheduler functions)
- `layers/shared/shared/agentplane_client.py` (create)
- `functions/api/app/dependencies.py` (modify - replace MavenDep with AgentPlaneDep)

---

### Phase 2: AgentPlane Backend Changes

#### 2a. New endpoint: OAuth initiation as JSON

**File:** `~/code/agentplane/src/app/api/admin/agents/[agentId]/connectors/[toolkit]/initiate-oauth/route.ts` (create)

```
POST /api/admin/agents/{agentId}/connectors/{toolkit}/initiate-oauth
Auth: Bearer ADMIN_API_KEY
Response: { redirect_url: string }
```

Calls `initiateOAuthConnector(tenantId, toolkit, callbackUrl)` where callback URL includes `?mode=popup`. Returns redirect URL as JSON instead of doing HTTP redirect.

#### 2b. Modify OAuth callback for popup mode

**File:** `~/code/agentplane/src/app/api/admin/agents/[agentId]/connectors/[toolkit]/callback/route.ts` (modify)

When `?mode=popup` query param is present, return HTML page that calls `window.opener.postMessage({ type: 'agentplane_oauth_callback', success: true }, EXPECTED_ORIGIN)` and `window.close()` instead of redirecting to admin page.

#### Research Insights: OAuth Callback Security

**CRITICAL: Do NOT use `'*'` as targetOrigin.** The existing code in `EmbeddedApp.tsx` already has this vulnerability (`window.parent.postMessage({ type: 'maven_app_ready' }, '*')`). Fix it during this migration.

Instead, pass the expected origin as a query parameter to the callback URL, or configure it server-side:

```typescript
// In the callback page:
window.opener.postMessage(
  { type: 'agentplane_oauth_callback', success: true },
  'https://admin.envoy.app'  // specific origin, NOT '*'
);
```

---

### Phase 3: Envoy Backend Router + Frontend

#### 3a. FastAPI Router

**File:** `functions/api/app/routers/agentplane.py` (create)

```
Prefix: /api/v1/agentplane

# Skills
GET    /skills                     -> list skills from agent
POST   /skills                     -> create skill (add to agent.skills array)
GET    /skills/{folder}            -> get skill by folder name
PATCH  /skills/{folder}            -> update skill files
DELETE /skills/{folder}            -> remove skill from agent

# Connectors
GET    /connectors                 -> list connector statuses
GET    /toolkits                   -> list available Composio toolkits
POST   /connectors/add             -> add toolkit(s) to agent
DELETE /connectors/{slug}          -> remove toolkit from agent
POST   /connectors/{slug}/api-key  -> save API key for toolkit
POST   /connectors/{slug}/oauth    -> initiate OAuth, return redirect URL

# Activity / Runs
GET    /runs                       -> list runs (query: limit, offset, status)
GET    /runs/{run_id}              -> get run details + transcript
```

#### Research Insights: FastAPI Router

**Add explicit `response_model` on every route** (the current maven router has none -- this is a gap worth fixing):

```python
@router.get("/skills", response_model=SkillListResponse)
async def list_skills(client: AgentPlaneDep):
    return await client.list_skills()

@router.post("/skills", response_model=SkillResponse, status_code=201)
async def create_skill(body: SkillCreateRequest, client: AgentPlaneDep):
    return await client.create_skill(body.model_dump())
```

**Pydantic v2 schema design -- strict requests, permissive responses:**
```python
# Requests (strict)
class SkillCreateRequest(BaseModel):
    name: str
    slug: str
    prompt: str
    description: str | None = None

# Responses (permissive -- won't break if upstream adds fields)
class SkillResponse(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    name: str
    slug: str
    prompt: str
```

**Centralized error handling utility:**
```python
def _raise_for_upstream_error(exc: HTTPStatusError) -> None:
    status = exc.response.status_code
    try:
        detail = exc.response.json().get("detail", exc.response.text)
    except Exception:
        detail = exc.response.text

    if 400 <= status < 500:
        raise HTTPException(status_code=status, detail=detail)
    else:
        logger.error("AgentPlane upstream error: %d: %s", status, detail)
        raise HTTPException(status_code=502, detail="AgentPlane service error")
```

Apply this consistently in every route (current maven router only has error handling on `update_skill`, leaving other routes to return 500 on upstream errors).

**Also handle connection errors:**
```python
except (ConnectError, TimeoutException):
    raise HTTPException(status_code=503, detail="AgentPlane service unavailable")
```

#### 3b. Register Router + Remove Maven

**File:** `functions/api/app/main.py` (modify)

- Remove: `from app.routers import maven` and `app.include_router(maven.router, ...)`
- Add: `from app.routers import agentplane` and `app.include_router(agentplane.router, prefix="/api/v1/agentplane", tags=["agentplane"])`

#### 3c. Frontend: Rename Files (dedicated commit, no logic changes)

Use `git mv` to preserve history:

```bash
git mv admin-ui/src/pages/settings/MavenSkillsTab.tsx admin-ui/src/pages/settings/SkillsTab.tsx
git mv admin-ui/src/pages/settings/MavenConnectorsTab.tsx admin-ui/src/pages/settings/ConnectorsTab.tsx
git mv admin-ui/src/pages/settings/MavenInvocationsTab.tsx admin-ui/src/pages/settings/ActivityTab.tsx
```

Update imports in `Settings.tsx` and rename exported functions. No API path or logic changes in this commit.

#### 3d. Frontend: Update API paths + UI Changes (second commit)

**Skills Tab** (`SkillsTab.tsx`):
- Update API calls from `/maven/skills` to `/agentplane/skills`
- Adapt to folder-based skill model

**Skill Builder** (`SkillBuilder.tsx`, `SkillBuilderContext.tsx`):
- Update from `/maven/skills/{id}/files/*` to `/agentplane/skills/{folder}`
- Remove publish step (saves are immediate)

**Connectors Tab** (`ConnectorsTab.tsx`):
- 3-column responsive grid: `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4`
- Connector cards with logo, auth scheme badge, connection status, per-auth-type actions, remove button
- OAuth popup flow with origin validation

**Activity Tab** (`ActivityTab.tsx`):
- Status badges (completed/running/failed/cancelled)
- NDJSON transcript timeline with grouped events
- Expandable tool call cards

**Settings.tsx**:
- Update imports to new component names

#### Research Insights: Frontend

**OAuth popup hook with security:**
```typescript
// useOAuthPopup.ts
useEffect(() => {
  const handleMessage = (event: MessageEvent) => {
    // SECURITY: Always validate origin
    if (event.origin !== window.location.origin) return;
    if (event.data?.type !== 'agentplane_oauth_callback') return;
    // ... handle result
  };
  window.addEventListener('message', handleMessage);
  return () => window.removeEventListener('message', handleMessage);
}, []);
```

Key security rules:
1. Always check `event.origin` -- never skip
2. Always specify `targetOrigin` in `postMessage` -- never `'*'`
3. Handle popup blockers (`window.open` returns `null`)
4. Poll for popup close as fallback
5. Clean up event listeners in useEffect return

**NDJSON transcript rendering:**
- Parse with `split('\n')` + `JSON.parse` per line, skip blanks
- Group consecutive `tool_use` + `tool_result` events into collapsible cards
- Under 200 events: render all. Over 200: use "load more" pagination
- Only add TanStack Virtual if transcripts regularly exceed 1000 events

**API client migration -- centralized route constants:**
```typescript
// api/routes.ts
export const API_ROUTES = {
  agentplane: {
    skills: { list: '/agentplane/skills', ... },
    connectors: { list: '/agentplane/connectors', ... },
    runs: { list: '/agentplane/runs', ... },
  },
} as const;
```

**Existing postMessage vulnerability in `EmbeddedApp.tsx`:**
- Line 69 uses `window.parent.postMessage({ type: 'maven_app_ready' }, '*')` -- fix during migration
- `MavenConnectorsTab.tsx` listens for events without checking `event.origin` -- fix in rewrite

**Files:**
- `functions/api/app/routers/agentplane.py` (create)
- `functions/api/app/main.py` (modify - register both routers)
- `admin-ui/src/pages/Settings.tsx` (modify - update imports)
- `admin-ui/src/pages/settings/MavenSkillsTab.tsx` (rewrite -> `SkillsTab.tsx`)
- `admin-ui/src/pages/settings/MavenConnectorsTab.tsx` (rewrite -> `ConnectorsTab.tsx`)
- `admin-ui/src/pages/settings/MavenInvocationsTab.tsx` (rewrite -> `ActivityTab.tsx`)
- `admin-ui/src/pages/settings/SkillBuilder.tsx` (modify)
- `admin-ui/src/pages/settings/skill-builder/SkillBuilderContext.tsx` (modify)

---

### Phase 4: Runtime Invocation Migration

#### 4a. Update Lambda Functions

These Lambda functions currently import and use `MavenClient` for runtime AI invocations:

| File | Current Maven Usage | AgentPlane Replacement |
|------|-------------------|----------------------|
| `functions/campaign_executor/handler.py` | `maven.invoke_skill("envoy-content-generation", {...})` | `agentplane.run_agent(prompt)` |
| `functions/email_scheduler/handler.py` | `maven.generate_content()`, `maven.assess_stage()` | `agentplane.run_agent(prompt)` |
| `functions/sequence_scheduler/handler.py` | `maven.invoke_skill()` via personalization | `agentplane.run_agent(prompt)` |
| `functions/api/app/routers/content.py` | `maven.generate_content()` | `agentplane.run_agent(prompt)` |
| `functions/api/app/routers/setup.py` | `POST /setup/provision-skills` | Remove or replace with AgentPlane skill sync |

**Note:** The `run_agent()` method on AgentPlaneClient will need to consume the NDJSON stream from `POST /api/runs` and wait for the `result` event, then return the structured response. This replaces Maven's synchronous `invoke_skill()`.

#### 4b. Migrate MCP Router (DISCOVERED DEPENDENCY)

> **Research Insight:** `functions/api/app/routers/mcp.py` also depends on `MavenDep` at lines 535, 545, 571, 581, 658, 672, 694, 843, 2415+. This is a significant secondary dependency that was not in the original plan.

**File:** `functions/api/app/routers/mcp.py` (modify -- replace MavenDep with AgentPlaneDep)

#### Research Insights: Runtime Migration

**personalization.py Protocol is already well-architected:**
- `functions/sequence_scheduler/personalization.py` defines a `MavenClient` Protocol (line 12-17) with `invoke_skill(skill_name, payload)`.
- If `AgentPlaneClient` implements this same interface, `personalization.py` needs zero changes.
- If the AgentPlane API has a different invocation signature, create an adapter.

**NDJSON streaming in Lambda concerns:**
- Lambda has limited memory. Large AgentPlane responses could cause OOM.
- Implement max buffer size (4MB). Fail fast if exceeded.
- Set per-operation timeouts: content generation (60s), personalization (120s), full invocation (300s).
- Consider circuit breaker: if N consecutive calls fail/timeout, stop batch processing and return partial results.

**Rate limiting:**
- Maven's `MAX_CONCURRENT_MAVEN_CALLS = 10` may need adjustment for AgentPlane's concurrency limits.
- Test under load before production cutover.

---

### Phase 5: Maven Removal

#### 5a. Delete Maven Files

- `layers/shared/shared/maven_client.py` (delete)
- `functions/api/app/routers/maven.py` (delete)

#### 5b. Clean Up dependencies.py

- Remove `MavenClient` import, `get_maven_client`, `MavenDep`

#### 5c. Clean Up template.yaml

- Remove parameters: `MavenServiceAPIURL`, `MavenAdminAPIURL`
- Remove env vars: `MAVEN_SERVICE_API_URL`, `MAVEN_ADMIN_API_URL`
- Remove IAM policies: `execute-api:Invoke` for Maven API Gateway ARN, `bedrock-agentcore:InvokeAgentRuntime`
- Keep VPC/subnet/SG params (now renamed to Envoy-prefixed from Phase 0)

#### 5d. Database Cleanup Migration (future, after soak period)

```sql
-- 034_drop_maven_columns.sql
-- PREREQUISITE: All application code migrated. No Maven column references remain.
-- Run pg_stat_statements check first to verify.

SET LOCAL lock_timeout = '5s';

-- Backup before drop (cheap insurance)
CREATE TABLE IF NOT EXISTS organizations_maven_backup AS
SELECT id, maven_tenant_id, maven_config, maven_service_runtime_arn,
       maven_skills_provisioned_at, maven_skills_status
FROM organizations
WHERE maven_tenant_id IS NOT NULL;

-- Drop index first
DROP INDEX IF EXISTS idx_org_maven_tenant;

-- Drop Maven columns
ALTER TABLE organizations
DROP COLUMN IF EXISTS maven_tenant_id,
DROP COLUMN IF EXISTS maven_config,
DROP COLUMN IF EXISTS maven_service_runtime_arn,
DROP COLUMN IF EXISTS maven_skills_provisioned_at,
DROP COLUMN IF EXISTS maven_skills_status;
```

Note: `maven_session_id` on campaigns/sequences tables can be kept for historical data.

#### Research Insights: Column Dropping Safety

**Pre-drop validation:**
```sql
-- Check pg_stat_statements for any remaining Maven column references
SELECT query, calls FROM pg_stat_statements
WHERE query ILIKE '%maven_tenant_id%'
   OR query ILIKE '%maven_config%'
   OR query ILIKE '%maven_service_runtime_arn%';
```

**DROP COLUMN is fast** in PostgreSQL (metadata-only, no table rewrite), but irreversible. The backup table provides insurance.

**Files with Maven column references that must be cleared first:**
- `functions/api/app/dependencies.py` (lines 30-37)
- `functions/api/app/routers/setup.py` (lines 51-106)
- `functions/campaign_executor/handler.py` (lines 14-144)
- `functions/email_scheduler/handler.py` (lines 18-192)
- `functions/sequence_scheduler/handler.py` (lines 290-298)
- `layers/shared/shared/queries/sequences.py` (line 655)

---

### Phase 6: Data Migration + Cleanup

#### 6a. Backfill Existing Organizations

For the small `organizations` table, a SQL backfill or Python script works:

```python
# scripts/backfill_agentplane.py
async def backfill():
    conn = await asyncpg.connect(...)
    orgs = await conn.fetch("""
        SELECT id, maven_tenant_id FROM organizations
        WHERE agentplane_tenant_id IS NULL AND maven_tenant_id IS NOT NULL
    """)
    for org in orgs:
        tenant_id, agent_id = await provision_agentplane_tenant(org['id'])
        await conn.execute("""
            UPDATE organizations
            SET agentplane_tenant_id = $1, agentplane_agent_id = $2
            WHERE id = $3
        """, tenant_id, agent_id, org['id'])
```

Ensure idempotency with `WHERE agentplane_tenant_id IS NULL`.

#### 6b. Export Maven History (optional)

Before removing Maven access:
- Export invocation history to S3 for audit trail
- Consider keeping Activity tab functional for historical data (read-only from S3)

---

## Testing Strategy

#### Research Insights: Testing

**Layer 1 -- Unit test the client (mock httpx with `respx`):**
```python
@respx.mock
@pytest.mark.asyncio
async def test_list_skills(client):
    respx.get("https://agentplane.test/api/admin/agents/test-agent").mock(
        return_value=Response(200, json={"skills": [...]})
    )
    result = await client.list_skills()
    assert len(result) > 0
```

**Layer 2 -- Unit test routes (mock dependency):**
```python
app.dependency_overrides[get_agentplane_client] = lambda: mock_client
transport = ASGITransport(app=app)
async with AsyncClient(transport=transport, base_url="http://test") as client:
    response = await client.get("/api/v1/agentplane/skills")
    assert response.status_code == 200
```

Always call `app.dependency_overrides.clear()` after tests.

**Layer 3 -- Integration test (optional, against staging):**
```python
@pytest.mark.integration
async def test_agentplane_contract():
    client = AgentPlaneClient(tenant_id=..., api_url=STAGING_URL)
    skills = await client.list_skills()
    assert "skills" in skills
```

**Update `tests/conftest.py`** -- add `mock_agentplane_client` fixture alongside existing `mock_maven_client`.

---

## Files Summary

| File | Action | Phase | Codebase |
|------|--------|-------|----------|
| `migrations/033_agentplane_columns.sql` | Create | 1 | Envoy |
| `template.yaml` | Modify (add AP params/env vars) | 1 | Envoy |
| `layers/shared/shared/agentplane_client.py` | Create | 1 | Envoy |
| `functions/api/app/dependencies.py` | Modify (add AgentPlaneDep) | 1 | Envoy |
| AgentPlane OAuth routes | Create + Modify | 2 | AgentPlane |
| `functions/api/app/routers/agentplane.py` | Create | 3 | Envoy |
| `functions/api/app/main.py` | Modify (add router) | 3 | Envoy |
| `admin-ui/src/pages/Settings.tsx` | Modify (update imports) | 3 | Envoy |
| `admin-ui/src/pages/settings/SkillsTab.tsx` | Rewrite (was MavenSkillsTab) | 3 | Envoy |
| `admin-ui/src/pages/settings/ConnectorsTab.tsx` | Rewrite (was MavenConnectorsTab) | 3 | Envoy |
| `admin-ui/src/pages/settings/ActivityTab.tsx` | Rewrite (was MavenInvocationsTab) | 3 | Envoy |
| `admin-ui/src/pages/settings/SkillBuilder.tsx` | Modify | 3 | Envoy |
| `admin-ui/src/pages/settings/skill-builder/SkillBuilderContext.tsx` | Modify | 3 | Envoy |
| `functions/campaign_executor/handler.py` | Modify (use AgentPlane) | 4 | Envoy |
| `functions/email_scheduler/handler.py` | Modify (use AgentPlane) | 4 | Envoy |
| `functions/sequence_scheduler/handler.py` | Modify (use AgentPlane) | 4 | Envoy |
| `functions/sequence_scheduler/personalization.py` | Modify (update protocol) | 4 | Envoy |
| `functions/api/app/routers/content.py` | Modify (use AgentPlane) | 4 | Envoy |
| `functions/api/app/routers/setup.py` | Modify (remove provision-skills) | 4 | Envoy |
| `functions/api/app/routers/mcp.py` | Modify (MavenDep -> AgentPlaneDep) | 4 | Envoy |
| `layers/shared/shared/maven_client.py` | Delete | 5 | Envoy |
| `functions/api/app/routers/maven.py` | Delete | 5 | Envoy |
| `functions/api/app/dependencies.py` | Modify (remove MavenDep) | 5 | Envoy |
| `template.yaml` | Modify (remove Maven params/IAM) | 5 | Envoy |
| `migrations/034_drop_maven_columns.sql` | Create (future) | 5d | Envoy |

**Total: 25 files** (4 create, 16 modify, 3 rewrite, 2 delete)

---

## Acceptance Criteria

- [x] All three Settings tabs (Skills, Connectors, AI Activity) work via AgentPlane API
- [x] Skills CRUD works: create, view, edit files, delete
- [x] Skill Builder loads and saves files via AgentPlane
- [x] Connectors tab shows toolkit grid with auth scheme and status
- [x] Can add/remove Composio toolkits
- [x] Can save API keys for API_KEY-type connectors
- [x] OAuth flow works for OAuth-type connectors (with origin validation)
- [x] AI Activity lists runs with status, cost, turns, duration
- [x] Run detail shows transcript timeline with tool calls
- [x] Campaign executor generates content via AgentPlane
- [x] Email scheduler works via AgentPlane
- [x] Sequence scheduler personalization works via AgentPlane
- [x] MCP router works via AgentPlane
- [x] Zero references to "maven" remain in Python/TypeScript source (excluding migrations for history)
- [x] `maven_client.py` and `maven.py` router are deleted
- [x] API key stored in Secrets Manager (not just env var)
- [x] OAuth `postMessage` validates `event.origin`
- [ ] NAT Gateway verified for outbound HTTPS to AgentPlane

## Dependencies & Risks

### Critical Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Single API key for all orgs (tenant isolation regression) | Critical | Per-tenant keys if supported; else strict server-side validation |
| 3 | API key in environment variables | High | Secrets Manager + cold-start cache |
| 4 | NDJSON stream consumption in Lambda (memory/timeout) | High | Max buffer, per-operation timeouts, circuit breaker |
| 5 | Lambda VPC needs NAT Gateway for external HTTPS | High | AgentPlane is external HTTPS -- ensure NAT Gateway or VPC endpoint exists |
| 6 | OAuth postMessage wildcard origin | Medium | Validate event.origin, specify targetOrigin |
| 7 | MCP router also depends on MavenDep (6+ references) | Medium | Include in Phase 4 migration |

### Other Dependencies

- **AgentPlane must be deployed and accessible** with admin API key
- **Org data migration**: Existing orgs need `agentplane_tenant_id` and `agentplane_agent_id` populated (manual or migration script)
- **Skills data migration**: Existing Maven skills need to be exported and re-created as AgentPlane agent skills
- **Runtime invocation format change**: `run_agent()` returns differently than `invoke_skill()` - Lambda handlers need to parse NDJSON stream responses
- **No skill enable/disable**: AgentPlane doesn't have this concept - skills are either present or not
- **No publish workflow**: AgentPlane skills are live immediately on save
- **Rate limiting**: Maven's `MAX_CONCURRENT_MAVEN_CALLS = 10` may need adjustment for AgentPlane

## References

### Envoy (current Maven integration)
- `layers/shared/shared/maven_client.py` - Maven client with AWS SigV4 auth
- `functions/api/app/routers/maven.py` - Maven REST proxy routes
- `functions/api/app/routers/mcp.py` - MCP tools (also depends on MavenDep)
- `functions/api/app/dependencies.py:27-41` - MavenDep injection
- `admin-ui/src/pages/settings/MavenSkillsTab.tsx` - Skills UI
- `admin-ui/src/pages/settings/MavenConnectorsTab.tsx` - Connectors UI
- `admin-ui/src/pages/settings/MavenInvocationsTab.tsx` - Activity UI
- `admin-ui/src/pages/EmbeddedApp.tsx` - Embedded mode (has postMessage vulnerability)

### AgentPlane (target)
- `src/lib/types.ts:25-33` - AgentSkill/AgentSkillFile types
- `src/lib/validation.ts:42-48` - UpdateAgentSchema with skills
- `src/app/api/admin/agents/[agentId]/route.ts` - Agent PATCH (skills update)
- `src/app/api/admin/agents/[agentId]/connectors/route.ts` - Connector management
- `src/app/api/admin/composio/toolkits/route.ts` - Available toolkits
- `src/app/api/admin/runs/route.ts` - Runs list with filters
- `src/app/api/admin/runs/[runId]/route.ts` - Run detail + transcript
- `src/lib/composio.ts` - ConnectorStatus interface, OAuth initiation

### Research Sources
- [HTTPX Async Client](https://www.python-httpx.org/async/) - Connection management, streaming, timeouts
- [Tenacity Retry Library](https://tenacity.readthedocs.io/) - Retry patterns for async
- [FastAPI Dependencies](https://fastapi.tiangolo.com/tutorial/dependencies/) - Dependency injection patterns
- [FastAPI Testing with Overrides](https://fastapi.tiangolo.com/advanced/testing-dependencies/) - Mock patterns
- [PostgreSQL ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) - DDL behavior
- [Zero-Downtime Postgres Migrations](https://postgres.ai/blog/20210923-zero-downtime-postgres-schema-migrations-lock-timeout-and-retries) - lock_timeout pattern
- [MDN: Window.postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage) - Security model
- [Pydantic v2 ConfigDict](https://docs.pydantic.dev/latest/api/config/) - `extra="allow"` for forward compatibility
