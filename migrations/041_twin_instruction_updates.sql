-- Migration: 041_twin_instruction_updates.sql
-- Audit trail for PUT /api/v1/twin/instructions. Twin's update-instructions
-- API silently rewrites the agent's behavior; without an app-side record we
-- have no way to answer "who changed this and when". The 100k length cap
-- lives in lib/schemas.ts (twinUpdateInstructions) — this table captures the
-- accepted content alongside the actor.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS twin_instruction_updates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_twin_instruction_updates_org
    ON twin_instruction_updates (organization_id, created_at DESC);

COMMIT;
