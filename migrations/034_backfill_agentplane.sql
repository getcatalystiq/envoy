-- Backfill agentplane_tenant_id and agentplane_agent_id for existing organizations
SET LOCAL lock_timeout = '5s';

UPDATE organizations
SET agentplane_tenant_id = '7db4538b-76f5-4ffc-b287-f135767009db',
    agentplane_agent_id  = '69199475-d9bc-4c72-b7f8-776d3ffe86d6'
WHERE agentplane_agent_id IS NULL;
