-- Migration: Drop skill_name and skill_reasoning columns from outbox table
-- These columns are no longer needed

ALTER TABLE outbox DROP COLUMN IF EXISTS skill_name;
ALTER TABLE outbox DROP COLUMN IF EXISTS skill_reasoning;
