-- Add Maven skills tracking to organizations

BEGIN;

-- Check if migration already applied
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '008') THEN
        RAISE EXCEPTION 'Migration 008 already applied';
    END IF;
END $$;

-- Add Maven skills tracking columns to organizations
ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS maven_skills_provisioned_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS maven_skills_status JSONB;

-- Record migration
INSERT INTO schema_migrations (version, description)
VALUES ('008', 'Add Maven skills tracking to organizations');

COMMIT;
