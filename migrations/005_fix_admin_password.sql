-- Migration 005: Previously fixed admin password hash.
-- Now a no-op — use `npm run setup` to create your admin account.

BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '005') THEN
        RAISE EXCEPTION 'Migration 005 already applied';
    END IF;
END $$;

-- Record migration
INSERT INTO schema_migrations (version, description)
VALUES ('005', 'Fix admin password (no-op, use npm run setup)');

COMMIT;
