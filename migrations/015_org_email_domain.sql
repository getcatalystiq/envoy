-- Migration: Add email domain support to organizations
-- Purpose: Allow organizations to send from their own verified domains

-- Add email domain columns to organizations (no separate table needed)
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS email_domain VARCHAR(255),
  ADD COLUMN IF NOT EXISTS email_domain_verified BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS email_domain_dkim_tokens TEXT[],
  ADD COLUMN IF NOT EXISTS email_from_name VARCHAR(100);

COMMENT ON COLUMN organizations.email_domain IS 'Custom sending domain for this org';
COMMENT ON COLUMN organizations.email_domain_verified IS 'Whether domain is verified in SES';
COMMENT ON COLUMN organizations.email_domain_dkim_tokens IS 'DKIM tokens for DNS setup';
COMMENT ON COLUMN organizations.email_from_name IS 'Display name for From header';
