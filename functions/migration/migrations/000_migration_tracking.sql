-- Migration tracking table
-- This should be run first before any other migrations

CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(50) PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT NOW(),
    description TEXT
);

-- Insert this migration as complete
INSERT INTO schema_migrations (version, description)
VALUES ('000', 'Migration tracking table')
ON CONFLICT (version) DO NOTHING;
