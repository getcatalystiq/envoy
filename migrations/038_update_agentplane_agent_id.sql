-- Update agentplane_agent_id for all organizations
UPDATE organizations
SET agentplane_agent_id = 'ad4219ba-4fc9-4fca-b0d0-948ca6e242be'
WHERE agentplane_agent_id IS NULL
   OR agentplane_agent_id = '69199475-d9bc-4c72-b7f8-776d3ffe86d6';
