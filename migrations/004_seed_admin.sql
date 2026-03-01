-- Migration 004: Previously seeded a default admin user.
-- Now a no-op — use `npm run setup` to create your admin account.

BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '004') THEN
        RAISE EXCEPTION 'Migration 004 already applied';
    END IF;
END $$;

-- Record migration
INSERT INTO schema_migrations (version, description)
VALUES ('004', 'Seed admin (no-op, use npm run setup)');

COMMIT;
