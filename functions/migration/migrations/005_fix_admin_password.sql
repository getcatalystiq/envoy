-- Fix admin user password hash

BEGIN;

-- Check if migration already applied
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '005') THEN
        RAISE EXCEPTION 'Migration 005 already applied';
    END IF;
END $$;

-- Update admin user with correct bcrypt hash for 'admin123'
UPDATE users
SET password_hash = '$2b$12$B9PyHa0kOh4XQsTzKKcqbe7TePloKpF86Tbydls4b4OsSWR4DZ81i'
WHERE email = 'admin@envoy.app';

-- Record migration
INSERT INTO schema_migrations (version, description)
VALUES ('005', 'Fix admin user password hash');

COMMIT;
