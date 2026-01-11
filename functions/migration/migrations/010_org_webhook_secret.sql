-- Migration: Add webhook secret to organizations
-- Purpose: Enable simple secret header authentication for target ingestion webhook

-- Add webhook_secret column to organizations
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS webhook_secret VARCHAR(64);

COMMENT ON COLUMN organizations.webhook_secret IS 'Secret key for webhook authentication (X-Webhook-Secret header)';
