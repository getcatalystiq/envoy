-- Migration: 036_drop_rls.sql
-- Drop all Row Level Security policies and disable RLS on all tables.
--
-- Why: Moving from Postgres RLS-based tenant isolation to application-level
-- tenant isolation with explicit WHERE organization_id clauses in every query.
-- This is required for the Vercel/Neon migration where connection pooling and
-- serverless drivers do not support SET app.current_org per-session.

BEGIN;

-- organizations
DROP POLICY IF EXISTS organizations_tenant ON organizations;
ALTER TABLE organizations DISABLE ROW LEVEL SECURITY;

-- users
DROP POLICY IF EXISTS users_tenant ON users;
ALTER TABLE users DISABLE ROW LEVEL SECURITY;

-- target_types
DROP POLICY IF EXISTS target_types_tenant ON target_types;
ALTER TABLE target_types DISABLE ROW LEVEL SECURITY;

-- segments
DROP POLICY IF EXISTS segments_tenant ON segments;
ALTER TABLE segments DISABLE ROW LEVEL SECURITY;

-- targets
DROP POLICY IF EXISTS targets_tenant ON targets;
ALTER TABLE targets DISABLE ROW LEVEL SECURITY;

-- content
DROP POLICY IF EXISTS content_tenant ON content;
ALTER TABLE content DISABLE ROW LEVEL SECURITY;

-- campaigns
DROP POLICY IF EXISTS campaigns_tenant ON campaigns;
ALTER TABLE campaigns DISABLE ROW LEVEL SECURITY;

-- email_sends
DROP POLICY IF EXISTS email_sends_tenant ON email_sends;
ALTER TABLE email_sends DISABLE ROW LEVEL SECURITY;

-- engagement_events
DROP POLICY IF EXISTS engagement_events_tenant ON engagement_events;
ALTER TABLE engagement_events DISABLE ROW LEVEL SECURITY;

-- agent_sessions
DROP POLICY IF EXISTS agent_sessions_tenant ON agent_sessions;
ALTER TABLE agent_sessions DISABLE ROW LEVEL SECURITY;

-- outbox
DROP POLICY IF EXISTS outbox_org_isolation ON outbox;
ALTER TABLE outbox DISABLE ROW LEVEL SECURITY;

-- sequences
DROP POLICY IF EXISTS sequences_tenant ON sequences;
ALTER TABLE sequences DISABLE ROW LEVEL SECURITY;

-- sequence_steps
DROP POLICY IF EXISTS sequence_steps_tenant ON sequence_steps;
ALTER TABLE sequence_steps DISABLE ROW LEVEL SECURITY;

-- sequence_enrollments
DROP POLICY IF EXISTS sequence_enrollments_tenant ON sequence_enrollments;
ALTER TABLE sequence_enrollments DISABLE ROW LEVEL SECURITY;

-- sequence_step_executions
DROP POLICY IF EXISTS sequence_step_executions_tenant ON sequence_step_executions;
ALTER TABLE sequence_step_executions DISABLE ROW LEVEL SECURITY;

-- design_templates
DROP POLICY IF EXISTS design_templates_org_isolation ON design_templates;
ALTER TABLE design_templates DISABLE ROW LEVEL SECURITY;

COMMIT;
