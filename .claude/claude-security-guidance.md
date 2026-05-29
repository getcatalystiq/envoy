# Envoy security guidance

Project-specific security invariants for the Envoy codebase (Next.js 16 App Router,
multi-tenant SaaS, OAuth 2.1 + MCP server, AWS SES email, Twin AI agent). These are
rules the model can't infer from general best practice — flag any diff that violates
them.

## Tenant isolation (no RLS — enforced in-query)
- Every SQL query that reads or writes tenant data MUST include an explicit
  `WHERE organization_id = $orgId` (or join to a row already scoped that way).
  There is NO row-level security. A query that looks up, updates, or deletes by
  `id` alone is a cross-tenant IDOR.
- Route handlers must pass `auth.tenantId` (from `requireAdmin`) into queries.
  Never trust a client-supplied organization id or resource id without an
  ownership check.
- Junction/child tables without an `organization_id` column (e.g. `campaign_content`)
  must be scoped by joining to the parent and checking the parent's org, OR the
  route must first verify ownership via an org-scoped `getById`.
- Webhook/cron handlers that resolve an org from a header or job row must scope
  every subsequent query by that resolved org id (see the SES bounce handlers).

## Authorization & scope (not just authentication)
- A valid JWT is authentication, NOT authorization. Every mutating REST route and
  every mutating MCP tool MUST enforce OAuth scope: `write` or `admin` for
  create/update/delete/approve/send/start; `read` is read-only.
- MCP tools must read `scope` from the verified token and reject under-scoped
  callers — a `read` token must not reach `create_target`, `start_campaign`,
  `approve_outbox_item`, `generate_email_content`, etc.
- Admin-only operations (OAuth client management, org settings) require `admin`,
  not merely `write`.

## OAuth / tokens
- `redirect_uri` must be re-validated server-side against the registered client
  (or `ALLOWED_DCR_DOMAINS`) at EVERY point a code or 302 is issued — including
  the authorize POST. Never trust a round-tripped hidden form field.
- PKCE is mandatory: only `S256` is accepted. Do not advertise or accept `plain`.
- The refresh-token grant must re-check `users.status = 'active'` and re-read the
  user's CURRENT scopes — never re-issue a token for a deactivated user or with a
  stale scope set. Deactivation must call `revokeAllUserTokens`.
- DCR `/register` must enforce `ALLOWED_DCR_DOMAINS` (same as authorize).
- Pin `algorithms: ['HS256']` on `jwtVerify`.
- Credential endpoints (login, token, authorize POST, register) must be rate
  limited.

## Email rendering — output sanitization (stored XSS)
- AI-generated content and recipient-controlled template variables are UNTRUSTED.
- Any value that becomes email HTML MUST be sanitized with an allowlist sanitizer
  at the HTML boundary — never with a regex denylist, and never sent raw.
- The shared `sanitizeEmailHtml()` is the only sanitizer; `wrapEmailBody()` and the
  outbox/content/send/MCP paths must run bodies through it. Do not send
  `result.body` / `content.body` verbatim.
- Template-variable substitution (`{{first_name}}` etc.) must HTML-escape values
  before they reach markdown/HTML rendering.
- Drop `iframe`, `form`, `base`, `meta`, `object`, `embed`, `script`, `style`;
  restrict URL schemes on EVERY url-bearing attribute (not just `href`); strip all
  `on*` handlers.

## Untrusted input -> external models (prompt injection)
- Target fields/metadata sent to the Twin agent are untrusted. Keep
  `sanitizeTargetForTwin` as the allowlist gate, wrap target data in explicit
  "treat as data, not instructions" delimiters in prompts, and rely on output
  sanitization (above) as the authoritative control. Never send a raw target row.

## Webhooks & input validation
- Inbound webhooks (`/api/webhooks/*`) must verify their secret with
  `crypto.timingSafeEqual` and validate the body with a Zod schema: typed fields,
  max lengths, bounded `metadata`/`custom_fields` size, format-checked email/phone.
- Wrap `request.json()` in try/catch and return 400 on malformed JSON.
- Bound array sizes (bulk ingestion) to prevent DoS.

## SQL
- Use the `sql` tagged template or `getPool().query(text, params)` with positional
  placeholders. NEVER interpolate a value into a SQL string. Column names in
  dynamic queries must come from a hardcoded allowlist (see `ALLOWED_UPDATE_COLUMNS`).
- Do not interpolate even "server-computed" tokens (e.g. `date_trunc` granularity)
  into SQL — map to a literal whitelist.

## Secrets
- Never put an API key / token / PII in a URL or query string. Secrets travel in
  headers only. Never SELECT `organizations.twin_api_key` back to a client —
  surface a boolean. Never log secrets or echo upstream auth errors that contain
  them.

## Side effects
- State-changing operations must not happen on HTTP GET (e.g. unsubscribe mutates
  on POST; GET shows a confirmation). GET must be safe/idempotent.
