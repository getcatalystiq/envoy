-- Migration: Make target_type_id optional in sequences
-- Purpose: Allow sequences to apply to all targets, not just a specific type

BEGIN;

-- Check if migration already applied
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '014') THEN
        RAISE EXCEPTION 'Migration 014 already applied';
    END IF;
END $$;

-- Make target_type_id nullable
ALTER TABLE sequences ALTER COLUMN target_type_id DROP NOT NULL;

-- Record migration
INSERT INTO schema_migrations (version, description)
VALUES ('014', 'Make sequences.target_type_id optional');

COMMIT;
