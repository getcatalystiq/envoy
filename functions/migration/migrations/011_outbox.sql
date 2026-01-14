-- Migration: Create outbox table for human-in-the-loop approval
-- Purpose: Queue AI-generated content for human review before sending

-- Create outbox table
CREATE TABLE IF NOT EXISTS outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'linkedin', 'sms')),
    subject TEXT,
    body TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    skill_reasoning TEXT,
    confidence_score DECIMAL(3,2) CHECK (confidence_score BETWEEN 0 AND 1),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'snoozed', 'sent', 'failed')),
    priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
    scheduled_for TIMESTAMP WITH TIME ZONE,
    snooze_until TIMESTAMP WITH TIME ZONE,
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMP WITH TIME ZONE,
    rejection_reason TEXT,
    edit_history JSONB DEFAULT '[]'::jsonb,
    send_result JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);

-- Enable Row-Level Security (REQUIRED for multi-tenant isolation)
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Organization isolation
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'outbox' AND policyname = 'outbox_org_isolation'
    ) THEN
        CREATE POLICY outbox_org_isolation ON outbox
            USING (organization_id = current_setting('app.current_org_id', true)::uuid);
    END IF;
END
$$;

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_outbox_org_status ON outbox(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(organization_id, status, priority DESC, created_at)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_target ON outbox(target_id);
CREATE INDEX IF NOT EXISTS idx_outbox_snoozed ON outbox(organization_id, snooze_until)
    WHERE status = 'snoozed' AND snooze_until IS NOT NULL;

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_outbox_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_outbox_updated_at ON outbox;
CREATE TRIGGER trigger_outbox_updated_at
    BEFORE UPDATE ON outbox
    FOR EACH ROW
    EXECUTE FUNCTION update_outbox_updated_at();

COMMENT ON TABLE outbox IS 'Human-in-the-loop approval queue for AI-generated content';
COMMENT ON COLUMN outbox.confidence_score IS 'AI confidence 0-1: >0.9 high, 0.7-0.9 medium, <0.7 low';
COMMENT ON COLUMN outbox.edit_history IS 'Array of edits: [{timestamp, user_id, field, old_value, new_value}]';
COMMENT ON COLUMN outbox.skill_reasoning IS 'Agent transcript explaining content generation reasoning';
