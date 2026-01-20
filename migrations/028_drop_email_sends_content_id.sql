-- Migration 028: Drop content_id from email_sends
-- Purpose: content_id is redundant since we store subject and body directly

-- Drop the foreign key constraint and column
ALTER TABLE email_sends DROP COLUMN IF EXISTS content_id;
