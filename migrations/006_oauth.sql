-- OAuth 2.1 tables for authentication
-- Includes: oauth_clients, oauth_authorization_codes, oauth_refresh_tokens, settings

BEGIN;

-- Check if migration already applied
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '006') THEN
        RAISE EXCEPTION 'Migration 006 already applied';
    END IF;
END $$;

-- Add scopes column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS scopes TEXT[] DEFAULT ARRAY['read', 'write'];

-- Settings table (for JWT secret, etc.)
CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- OAuth Clients (RFC 7591 - Dynamic Client Registration)
CREATE TABLE oauth_clients (
    client_id VARCHAR(255) PRIMARY KEY,
    client_secret_hash VARCHAR(255),
    client_name VARCHAR(255) NOT NULL,
    client_uri VARCHAR(500),
    redirect_uris TEXT[] NOT NULL,
    grant_types TEXT[] NOT NULL DEFAULT ARRAY['authorization_code', 'refresh_token'],
    response_types TEXT[] NOT NULL DEFAULT ARRAY['code'],
    token_endpoint_auth_method VARCHAR(50) NOT NULL DEFAULT 'client_secret_basic',
    scope VARCHAR(500) DEFAULT 'read write',
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_oauth_clients_org ON oauth_clients(organization_id) WHERE organization_id IS NOT NULL;

-- OAuth Authorization Codes
CREATE TABLE oauth_authorization_codes (
    code VARCHAR(255) PRIMARY KEY,
    client_id VARCHAR(255) NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri VARCHAR(500) NOT NULL,
    scope VARCHAR(500) NOT NULL,
    code_challenge VARCHAR(255),
    code_challenge_method VARCHAR(10) DEFAULT 'S256',
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_oauth_codes_client ON oauth_authorization_codes(client_id);
CREATE INDEX idx_oauth_codes_user ON oauth_authorization_codes(user_id);
CREATE INDEX idx_oauth_codes_expires ON oauth_authorization_codes(expires_at);

-- OAuth Refresh Tokens
CREATE TABLE oauth_refresh_tokens (
    token_hash VARCHAR(255) PRIMARY KEY,
    client_id VARCHAR(255) NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope VARCHAR(500) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_oauth_refresh_client ON oauth_refresh_tokens(client_id);
CREATE INDEX idx_oauth_refresh_user ON oauth_refresh_tokens(user_id);
CREATE INDEX idx_oauth_refresh_expires ON oauth_refresh_tokens(expires_at) WHERE revoked_at IS NULL;

-- Record migration
INSERT INTO schema_migrations (version, description)
VALUES ('006', 'OAuth 2.1 tables - clients, authorization_codes, refresh_tokens, settings');

COMMIT;
