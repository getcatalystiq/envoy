-- Migration: Add phone support to targets table
-- Purpose: Enable smart matching on phone numbers for target ingestion webhook

-- Add phone columns to targets table
ALTER TABLE targets ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
ALTER TABLE targets ADD COLUMN IF NOT EXISTS phone_normalized VARCHAR(20);

-- Create partial unique index on normalized phone (only when not null)
-- This allows multiple NULL values but enforces uniqueness for non-null phones within an org
CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_org_phone
ON targets(organization_id, phone_normalized)
WHERE phone_normalized IS NOT NULL;

-- Add composite index for matching lookups (email OR phone within org)
CREATE INDEX IF NOT EXISTS idx_targets_org_email_phone
ON targets(organization_id, email, phone_normalized);

COMMENT ON COLUMN targets.phone IS 'Original phone number as provided';
COMMENT ON COLUMN targets.phone_normalized IS 'E.164 normalized phone for matching (e.g., +12025551234)';
