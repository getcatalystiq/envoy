-- Migration: 039_rename_agentplane_to_twin.sql
-- Rename AgentPlane org columns for the Twin integration.
-- Twin has no tenant concept, so agentplane_tenant_id is dropped.
--
-- WARNING: DROP COLUMN agentplane_tenant_id is irreversible. Operators MUST
-- take a pre-deploy database snapshot before running this migration. The
-- RENAME is NOT rolling-deploy safe — pause cron jobs (sequence-scheduler,
-- campaign-executor, email-sender) during cutover so workers do not see
-- a half-renamed schema.

SET LOCAL lock_timeout = '5s';

ALTER TABLE organizations
  DROP COLUMN IF EXISTS agentplane_tenant_id;

-- Idempotent rename: only attempt the rename if the source column exists
-- and the destination column does not yet exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'agentplane_agent_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'twin_agent_id'
  ) THEN
    ALTER TABLE organizations RENAME COLUMN agentplane_agent_id TO twin_agent_id;
  END IF;
END $$;

-- Migrations 034 and 038 stamped AgentPlane UUIDs into every org's
-- agentplane_agent_id. Those UUIDs are NOT valid Twin agent IDs, so
-- carrying them forward would cause every generateContent call to 404.
-- NULL them out so operators must reconfigure with real Twin agent IDs.
UPDATE organizations
SET twin_agent_id = NULL
WHERE twin_agent_id IN (
  'ad4219ba-4fc9-4fca-b0d0-948ca6e242be',
  '69199475-d9bc-4c72-b7f8-776d3ffe86d6'
);
