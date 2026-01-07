-- Fix oauth_authorization_codes table - rename code_hash to code

BEGIN;

-- Check if migration already applied
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '007') THEN
        RAISE EXCEPTION 'Migration 007 already applied';
    END IF;
END $$;

-- Rename column if it exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'oauth_authorization_codes' AND column_name = 'code_hash') THEN
        ALTER TABLE oauth_authorization_codes RENAME COLUMN code_hash TO code;
    END IF;
END $$;

-- Record migration
INSERT INTO schema_migrations (version, description)
VALUES ('007', 'Fix oauth_authorization_codes code_hash to code');

COMMIT;
