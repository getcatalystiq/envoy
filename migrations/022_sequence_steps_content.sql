-- Migration: Add subject, builder_content, and has_unpublished_changes to sequence_steps
-- Purpose: Store email content directly on steps instead of referencing content table

BEGIN;

-- Check if migration already applied
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '022') THEN
        RAISE EXCEPTION 'Migration 022 already applied';
    END IF;
END $$;

-- Add content fields to sequence_steps
ALTER TABLE sequence_steps
    ADD COLUMN subject VARCHAR(998),
    ADD COLUMN builder_content JSONB,
    ADD COLUMN has_unpublished_changes BOOLEAN NOT NULL DEFAULT false;

-- Drop sequence_step_contents table (no longer needed)
DROP TABLE IF EXISTS sequence_step_contents;

-- Record migration
INSERT INTO schema_migrations (version, description)
VALUES ('022', 'Add content fields to sequence_steps, drop sequence_step_contents');

COMMIT;
