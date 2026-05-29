-- Migration: 040_twin_run_id.sql
-- Add twin_run_id to sequence_step_executions so the sequence-scheduler cron can
-- resume polling an in-flight Twin run instead of starting a duplicate when a
-- cron tick crashes between startRun and final result. Without this, the next
-- tick fires a fresh Twin run for the same (enrollment, step) — double billing
-- and (when approval_required=false) potential duplicate emails.

BEGIN;

-- Safety: short lock timeout so a busy table fails fast rather than blocking writes.
SET LOCAL lock_timeout = '5s';

ALTER TABLE sequence_step_executions
  ADD COLUMN IF NOT EXISTS twin_run_id TEXT;

COMMENT ON COLUMN sequence_step_executions.twin_run_id
    IS 'When non-NULL, a Twin run is in-flight for this (enrollment, step). Cleared on success so completed rows have NULL.';

-- Partial index for fast inflight lookup. NOT unique — a step may legitimately
-- carry a transient twin_run_id across retries, and we don''t want to wedge the
-- cron if the column ever gets duplicated.
CREATE INDEX IF NOT EXISTS idx_step_executions_inflight_twin_run
    ON sequence_step_executions (enrollment_id, step_position)
    WHERE twin_run_id IS NOT NULL;

COMMIT;
