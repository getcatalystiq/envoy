-- Performance indexes for Envoy

BEGIN;

-- Check if migration already applied
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '002') THEN
        RAISE EXCEPTION 'Migration 002 already applied';
    END IF;
END $$;

-- Targets indexes
CREATE INDEX idx_targets_org_status_lifecycle ON targets(organization_id, status, lifecycle_stage);
CREATE INDEX idx_targets_org_segment ON targets(organization_id, segment_id);
CREATE INDEX idx_targets_org_type_status ON targets(organization_id, target_type_id, status);

-- Content indexes
CREATE INDEX idx_content_org_type ON content(organization_id, content_type);
CREATE INDEX idx_content_org_channel_status ON content(organization_id, channel, status);

-- Campaigns indexes
CREATE INDEX idx_campaigns_org_status ON campaigns(organization_id, status);
CREATE INDEX idx_campaigns_scheduled ON campaigns(scheduled_at)
    WHERE status = 'scheduled';

-- Campaign content index
CREATE INDEX idx_campaign_content_content ON campaign_content(content_id);

-- Email sends indexes
CREATE INDEX idx_email_sends_org_status ON email_sends(organization_id, status);
CREATE INDEX idx_email_sends_campaign_status ON email_sends(campaign_id, status);
CREATE INDEX idx_email_sends_target ON email_sends(target_id, created_at DESC);
CREATE INDEX idx_email_sends_ses ON email_sends(ses_message_id)
    WHERE ses_message_id IS NOT NULL;
CREATE INDEX idx_email_sends_scheduled ON email_sends(scheduled_at)
    WHERE status = 'queued' AND scheduled_at IS NOT NULL;

-- Engagement events indexes
CREATE INDEX idx_events_send ON engagement_events(send_id, occurred_at DESC);
CREATE INDEX idx_events_org_type ON engagement_events(organization_id, event_type);
CREATE INDEX idx_events_occurred ON engagement_events(organization_id, occurred_at DESC);

-- Agent sessions indexes
CREATE INDEX idx_sessions_maven ON agent_sessions(maven_session_id);
CREATE INDEX idx_sessions_org_type ON agent_sessions(organization_id, agent_type);

-- Record migration
INSERT INTO schema_migrations (version, description)
VALUES ('002', 'Performance indexes');

COMMIT;
