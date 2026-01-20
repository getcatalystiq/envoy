-- Migration 027: Add complained_at to email_sends
-- Purpose: Track when an email recipient filed a complaint

-- Add complained_at column
ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS complained_at TIMESTAMPTZ;

-- Update status constraint to include 'complained'
ALTER TABLE email_sends DROP CONSTRAINT IF EXISTS email_sends_status_check;
ALTER TABLE email_sends ADD CONSTRAINT email_sends_status_check
    CHECK (status IN ('queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'failed'));

-- Add index for filtering by complaint status
CREATE INDEX IF NOT EXISTS idx_email_sends_complained_at ON email_sends(complained_at) WHERE complained_at IS NOT NULL;

COMMENT ON COLUMN email_sends.complained_at IS 'Timestamp when recipient filed a spam complaint';
