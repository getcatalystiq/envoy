-- 0.10.0 — a failure counter for the drip step's backoff and attempt cap.
--
-- The engine now backs a failing step off (15 min, doubling, at most a day) and, after `maxAttempts`
-- recorded failures, marks the step `failed` and the enrollment `stopped` instead of retrying it every
-- tick forever. It counts in this NEW column, not in `sdk_steps.attempts`: `attempts` also counts the
-- send itself and every failure recorded before 0.10.0 (one step held 10,754), so capping on it would
-- stop such a step on its first failure after the upgrade. Every row starts at 0.
--
-- IDEMPOTENT / RE-RUN-SAFE: host runners re-run every migration each deploy, so ADD COLUMN IF NOT
-- EXISTS only. The 0.10.0 engine writes this column, so a host applies this migration BEFORE (or with)
-- deploying 0.10.0; an older engine ignores it.

ALTER TABLE sdk_steps
  ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;
