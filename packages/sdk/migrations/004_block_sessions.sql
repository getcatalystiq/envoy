-- U3a — per-block crash-resume marker for the per-block drip agent contract.
--
-- The drip agent now returns ONE block ({"body": ...}) per call, so the engine invokes it once per AI
-- slot. The single per-step inflight marker (sdk_steps.agent_session_id, 001_core.sql) can hold only
-- one session id, so a multi-slot step needs one marker PER slot or a mid-step crash would re-bill an
-- already-run block. `block_sessions` is a { slotName -> sessionId } map; markBlockInflight merges into
-- it before each slot's billed turn, and a re-claim harvests each completed slot's session for free.
--
-- The old agent_session_id column is left in place (unread by the new engine; a later cleanup may drop
-- it). A step mid-generation at the exact deploy instant has agent_session_id set but block_sessions
-- empty, so its slot re-runs once — a bounded, one-time micro re-bill (send-gate still prevents a
-- double-send).
--
-- IDEMPOTENT / RE-RUN-SAFE: host runners re-run every migration each deploy, so use ADD COLUMN
-- IF NOT EXISTS — no functions / DO-blocks / ALTER ADD CONSTRAINT.

ALTER TABLE sdk_steps
  ADD COLUMN IF NOT EXISTS block_sessions JSONB NOT NULL DEFAULT '{}'::jsonb;
