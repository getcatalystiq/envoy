-- Migration: 045_session_resume.sql
-- Rename the sequence-scheduler crash-resume marker from the Twin run id to the
-- Managed Agents session id. A non-NULL agent_session_id means a session was
-- created for this (enrollment, step) before the billed turn; the next tick
-- harvests its events instead of creating a new (billed) session.

SET LOCAL lock_timeout = '5s';

-- Inflight markers hold *Twin* run ids, which are not valid Managed Agents
-- session ids. Carrying them into agent_session_id would make the next tick try
-- to harvest a nonexistent session (retrieve fails -> null -> a fresh, billed
-- session is created for every inflight row). NULL them first so those steps
-- start clean on the new stack — then rename. Both guarded on twin_run_id
-- still existing, so the migration stays replay-safe.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sequence_step_executions' AND column_name = 'twin_run_id'
  ) THEN
    UPDATE sequence_step_executions SET twin_run_id = NULL WHERE twin_run_id IS NOT NULL;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'sequence_step_executions' AND column_name = 'agent_session_id'
    ) THEN
      ALTER TABLE sequence_step_executions RENAME COLUMN twin_run_id TO agent_session_id;
    END IF;
  END IF;
END $$;

-- Replace the partial inflight index (was keyed on twin_run_id IS NOT NULL).
DROP INDEX IF EXISTS idx_step_executions_inflight_twin_run;
CREATE INDEX IF NOT EXISTS idx_step_executions_inflight_agent_session
  ON sequence_step_executions (enrollment_id, step_position)
  WHERE agent_session_id IS NOT NULL;

COMMENT ON COLUMN sequence_step_executions.agent_session_id
  IS 'When non-NULL, a Managed Agents session is inflight for this (enrollment, step). Cleared on success.';
