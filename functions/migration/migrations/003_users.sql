-- Users table for authentication
-- Each user belongs to an organization

BEGIN;

-- Check if migration already applied
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '003') THEN
        RAISE EXCEPTION 'Migration 003 already applied';
    END IF;
END $$;

-- Users
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    role VARCHAR(50) NOT NULL DEFAULT 'member'
        CHECK (role IN ('admin', 'member', 'viewer')),
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive', 'pending')),
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_org ON users(organization_id);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_tenant ON users
    USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Record migration
INSERT INTO schema_migrations (version, description)
VALUES ('003', 'Users table for authentication');

COMMIT;
