-- Migration: 033_agentplane_columns.sql
-- Add AgentPlane tenant and agent ID columns to organizations

SET LOCAL lock_timeout = '5s';

ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS agentplane_tenant_id TEXT,
ADD COLUMN IF NOT EXISTS agentplane_agent_id TEXT;
