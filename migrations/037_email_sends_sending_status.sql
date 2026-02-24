-- Migration 037: Add 'sending' status and processing_started_at for cron concurrency guards
-- Purpose: Enable atomic claim pattern for email sending and campaign execution

-- Add processing_started_at to email_sends for stuck-sending detection
ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

-- Update status constraint to include 'sending'
ALTER TABLE email_sends DROP CONSTRAINT IF EXISTS email_sends_status_check;
ALTER TABLE email_sends ADD CONSTRAINT email_sends_status_check
    CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'failed'));

-- Index for the stuck-sending reaper query
CREATE INDEX IF NOT EXISTS idx_email_sends_sending_started
    ON email_sends(processing_started_at)
    WHERE status = 'sending';

-- Add processing_started_at to campaigns for concurrent execution guard
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

COMMENT ON COLUMN email_sends.processing_started_at IS 'When the sending process claimed this row; used to detect stuck items';
COMMENT ON COLUMN campaigns.processing_started_at IS 'When the executor claimed this campaign; used to detect stuck items';
