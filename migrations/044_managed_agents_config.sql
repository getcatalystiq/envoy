-- Migration: 044_managed_agents_config.sql
-- Swap per-org Twin config for Claude Managed Agents config.
--   twin_agent_id  -> agent_id        (carried values NULLed — Twin ids are not
--                                       valid Anthropic agent ids)
--   + environment_id (new)            required by sessions.create; NULL falls
--                                       back to ANTHROPIC_DEFAULT_ENVIRONMENT_ID
--   - twin_api_key   (dropped)        Managed Agents auth is the deployment-wide
--                                       ANTHROPIC_API_KEY; no per-org key
--   + UNIQUE(agent_id)                two orgs cannot share an agent and read
--                                       each other's sessions
--
-- WARNING: DROP COLUMN twin_api_key is irreversible. Operators MUST take a
-- pre-deploy database snapshot before running this migration. The RENAME is NOT
-- rolling-deploy safe — pause cron jobs (sequence-scheduler, campaign-executor,
-- email-sender) during cutover so workers never see a half-renamed schema.

SET LOCAL lock_timeout = '5s';

-- Idempotent rename: only attempt if the source column exists and the
-- destination does not yet exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'twin_agent_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'agent_id'
  ) THEN
    ALTER TABLE organizations RENAME COLUMN twin_agent_id TO agent_id;
  END IF;
END $$;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS environment_id TEXT;

ALTER TABLE organizations
  DROP COLUMN IF EXISTS twin_api_key;

-- Carried-over agent_id values are Twin agent ids, which do not exist on the
-- Anthropic account. Leaving them would make orgs look configured (passing the
-- `agent_id IS NOT NULL` cron gate) while every sessions.create fails. NULL them
-- so operators must reconfigure with real Managed Agents ids.
UPDATE organizations SET agent_id = NULL WHERE agent_id IS NOT NULL;

-- One agent per org: prevents two orgs pointing at the same agent and reading
-- each other's sessions. Partial so multiple unconfigured (NULL) orgs coexist.
CREATE UNIQUE INDEX IF NOT EXISTS uq_organizations_agent_id
  ON organizations (agent_id)
  WHERE agent_id IS NOT NULL;

COMMENT ON COLUMN organizations.agent_id
  IS 'Claude Managed Agents agent id for this org. NULL = AI features unconfigured.';
COMMENT ON COLUMN organizations.environment_id
  IS 'Managed Agents environment id. NULL falls back to ANTHROPIC_DEFAULT_ENVIRONMENT_ID.';
