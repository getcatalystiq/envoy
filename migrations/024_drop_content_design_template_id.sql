-- Migration: Drop design_template_id from content table
-- Purpose: Column is unused - content now stores builder_content directly on sequence_steps

BEGIN;

-- Check if migration already applied
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '024') THEN
        RAISE EXCEPTION 'Migration 024 already applied';
    END IF;
END $$;

-- Drop the column
ALTER TABLE content DROP COLUMN IF EXISTS design_template_id;

-- Record migration
INSERT INTO schema_migrations (version, description)
VALUES ('024', 'Drop unused design_template_id from content table');

COMMIT;
