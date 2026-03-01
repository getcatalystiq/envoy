-- Migration: Add is_default column to sequences table
-- Purpose: Allow one default sequence per target_type for auto-enrollment

BEGIN;

-- Check if migration already applied
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '025') THEN
        RAISE EXCEPTION 'Migration 025 already applied';
    END IF;
END $$;

-- Add is_default column
ALTER TABLE sequences ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial unique index: only one default per (org, target_type)
-- Only applies to rows where is_default = TRUE and target_type_id is not null
CREATE UNIQUE INDEX idx_sequences_default_per_target_type
    ON sequences (organization_id, target_type_id)
    WHERE is_default = TRUE AND target_type_id IS NOT NULL;

-- Index for efficient lookup of default sequence
CREATE INDEX idx_sequences_default_lookup
    ON sequences (organization_id, target_type_id)
    WHERE is_default = TRUE;

-- Record migration
INSERT INTO schema_migrations (version, description)
VALUES ('025', 'Add is_default to sequences with partial unique index');

COMMIT;
