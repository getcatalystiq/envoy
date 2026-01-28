-- Migration: Add approval_required to sequence_steps
-- Purpose: Allow sequence steps to bypass human approval

BEGIN;

-- Safety: Set short lock timeout to fail fast if tables are busy
SET LOCAL lock_timeout = '3s';

-- Add approval_required to sequence_steps
-- PostgreSQL 11+: No table rewrite for static defaults (instant operation)
ALTER TABLE sequence_steps
ADD COLUMN approval_required BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN sequence_steps.approval_required
    IS 'When false, emails from this step bypass human approval and send automatically';

COMMIT;
