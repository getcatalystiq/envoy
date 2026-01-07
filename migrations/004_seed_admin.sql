-- Seed admin organization and user

BEGIN;

-- Check if migration already applied
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '004') THEN
        RAISE EXCEPTION 'Migration 004 already applied';
    END IF;
END $$;

-- Create demo organization
INSERT INTO organizations (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Demo Organization')
ON CONFLICT (id) DO NOTHING;

-- Create admin user with password 'admin123'
-- Password hash for 'admin123' generated with bcrypt
INSERT INTO users (id, organization_id, email, password_hash, first_name, last_name, role, status)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'admin@envoy.app',
    '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/X4JQ5ZdZaKqJwZz/O',
    'Admin',
    'User',
    'admin',
    'active'
)
ON CONFLICT (email) DO NOTHING;

-- Record migration
INSERT INTO schema_migrations (version, description)
VALUES ('004', 'Seed admin organization and user');

COMMIT;
