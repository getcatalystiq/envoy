-- Drop all Maven-era columns and indexes now that AgentPlane migration is complete

SET LOCAL lock_timeout = '5s';

-- organizations: drop Maven columns (replaced by agentplane_tenant_id / agentplane_agent_id)
DROP INDEX IF EXISTS idx_org_maven_tenant;

ALTER TABLE organizations
DROP COLUMN IF EXISTS maven_tenant_id,
DROP COLUMN IF EXISTS maven_config,
DROP COLUMN IF EXISTS maven_skills_provisioned_at,
DROP COLUMN IF EXISTS maven_skills_status,
DROP COLUMN IF EXISTS maven_service_runtime_arn;

-- campaigns: drop maven_session_id
ALTER TABLE campaigns
DROP COLUMN IF EXISTS maven_session_id;

-- agent_sessions: drop maven_session_id and its index
DROP INDEX IF EXISTS idx_sessions_maven;

ALTER TABLE agent_sessions
DROP COLUMN IF EXISTS maven_session_id;

INSERT INTO _migrations (version, name)
VALUES ('035', 'Drop Maven columns and indexes');
