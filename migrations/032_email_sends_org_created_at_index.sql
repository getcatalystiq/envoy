-- Add index for organization_id + created_at on email_sends table
-- This optimizes time-range queries for dashboard and analytics tools
-- The index uses (organization_id, created_at) to support:
--   - Filtering by organization_id (equality)
--   - Range scans on created_at (time-based filtering)

CREATE INDEX IF NOT EXISTS idx_email_sends_org_created_at
ON email_sends (organization_id, created_at);
