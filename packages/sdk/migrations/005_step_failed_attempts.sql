-- 0.10.0 — failure counters for the drip step's backoff and attempt cap.
--
-- The engine now backs a failing step off (15 min, doubling, at most 12 hours) and, after
-- `maxAttempts` PERMANENT failures, marks the step `failed` and the enrollment `stopped`, instead of
-- retrying it every tick forever. Two counters:
--   failed_attempts    every recorded failure; drives the backoff.
--   permanent_failures a turn that ended with no usable block, or a block still over Resend's 2,000-
--                      character limit after its regeneration; drives the cap. A failed agent call
--                      and every Resend refusal or transport error are transient: never counted.
-- Neither is `sdk_steps.attempts`: it also counts the send itself and every failure recorded before
-- 0.10.0 (one step held 10,754), so capping on it would stop such a step on its first failure after
-- the upgrade. Every row starts at 0.
--
-- IDEMPOTENT / RE-RUN-SAFE: host runners re-run every migration each deploy, so ADD COLUMN IF NOT
-- EXISTS only. The 0.10.0 engine writes these columns, so a host applies this migration BEFORE (or
-- with) deploying 0.10.0; an older engine ignores them.

ALTER TABLE sdk_steps
  ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS permanent_failures INTEGER NOT NULL DEFAULT 0;
