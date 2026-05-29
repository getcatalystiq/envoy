-- Migration: 042_twin_api_key.sql
-- Add per-org Twin API key override. Falls back to the TWIN_API_KEY env var
-- when null. Stored as text; encrypt at the database / connection layer if
-- your deployment requires it (Neon supports column-level encryption).

SET LOCAL lock_timeout = '5s';

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS twin_api_key TEXT;
