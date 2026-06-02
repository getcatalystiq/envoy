-- Migration: 046_org_vault_id.sql
-- Per-org Managed Agents vault id. A session passes `vault_ids` at create time
-- so the agent's MCP servers (e.g. firecrawl) can authenticate with stored
-- credentials. Per-tenant only (NULL = no vault attached). Additive +
-- rolling-deploy safe.

SET LOCAL lock_timeout = '5s';

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS vault_id TEXT;

COMMENT ON COLUMN organizations.vault_id
  IS 'Managed Agents vault id passed as session vault_ids so the agent MCP servers can authenticate. NULL falls back to ANTHROPIC_DEFAULT_VAULT_IDS.';
