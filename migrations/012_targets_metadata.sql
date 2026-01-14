-- Migration: Add metadata JSONB field to targets
-- Purpose: Store arbitrary key-value pairs for flexible data ingestion

ALTER TABLE targets ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_targets_metadata ON targets USING GIN (metadata);

COMMENT ON COLUMN targets.metadata IS 'Arbitrary key-value pairs for flexible data storage';
