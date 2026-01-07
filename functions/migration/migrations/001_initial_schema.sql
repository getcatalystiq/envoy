-- Initial schema for Envoy
-- Organizations, Target Types, Segments, Targets, Content, Campaigns

BEGIN;

-- Check if migration already applied
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '001') THEN
        RAISE EXCEPTION 'Migration 001 already applied';
    END IF;
END $$;

-- Organizations
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    maven_tenant_id UUID,
    maven_config JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_org_maven_tenant ON organizations(maven_tenant_id)
    WHERE maven_tenant_id IS NOT NULL;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY organizations_tenant ON organizations
    USING (id = current_setting('app.current_org_id', true)::uuid);

-- Target Types (End User, Partner, Reseller)
CREATE TABLE target_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    lifecycle_stages JSONB DEFAULT '[
        {"stage": 0, "name": "Unaware", "criteria": "No engagement"},
        {"stage": 1, "name": "Aware", "criteria": "Email open"},
        {"stage": 2, "name": "Interested", "criteria": "Multiple interactions"},
        {"stage": 3, "name": "Considering", "criteria": "Pricing page visit"},
        {"stage": 4, "name": "Intent", "criteria": "Demo request"},
        {"stage": 5, "name": "Converted", "criteria": "Payment received"},
        {"stage": 6, "name": "Advocate", "criteria": "Referral or review"}
    ]',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_target_types_org_name ON target_types(organization_id, name);

ALTER TABLE target_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY target_types_tenant ON target_types
    USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Segments (Film Production, Music, Trade Shows)
CREATE TABLE segments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    target_type_id UUID NOT NULL REFERENCES target_types(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    pain_points TEXT[],
    objections TEXT[],
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_segments_target_type_name ON segments(target_type_id, name);

ALTER TABLE segments ENABLE ROW LEVEL SECURITY;

CREATE POLICY segments_tenant ON segments
    USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Targets (leads/contacts)
CREATE TABLE targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    company VARCHAR(255),
    target_type_id UUID REFERENCES target_types(id) ON DELETE SET NULL,
    segment_id UUID REFERENCES segments(id) ON DELETE SET NULL,
    lifecycle_stage INTEGER NOT NULL DEFAULT 0 CHECK (lifecycle_stage BETWEEN 0 AND 6),
    custom_fields JSONB DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'unsubscribed', 'bounced')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_targets_org_email ON targets(organization_id, email);

ALTER TABLE targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY targets_tenant ON targets
    USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Content
CREATE TABLE content (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    content_type VARCHAR(50) NOT NULL,
    channel VARCHAR(50) NOT NULL DEFAULT 'email',
    subject VARCHAR(500),
    body TEXT NOT NULL,
    target_type_id UUID REFERENCES target_types(id) ON DELETE SET NULL,
    segment_id UUID REFERENCES segments(id) ON DELETE SET NULL,
    lifecycle_stage INTEGER CHECK (lifecycle_stage BETWEEN 0 AND 6),
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'archived')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE content ENABLE ROW LEVEL SECURITY;

CREATE POLICY content_tenant ON content
    USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Campaigns
CREATE TABLE campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'scheduled', 'active', 'paused', 'completed')),
    target_criteria JSONB DEFAULT '{}',
    skills JSONB DEFAULT '{}',
    scheduled_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    settings JSONB DEFAULT '{}',
    stats JSONB DEFAULT '{}',
    maven_session_id VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_campaigns_org_name ON campaigns(organization_id, name);

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY campaigns_tenant ON campaigns
    USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Campaign-Content junction table
CREATE TABLE campaign_content (
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    content_id UUID NOT NULL REFERENCES content(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (campaign_id, content_id)
);

-- Email Sends
CREATE TABLE email_sends (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
    target_id UUID REFERENCES targets(id) ON DELETE SET NULL,
    content_id UUID REFERENCES content(id) ON DELETE SET NULL,
    email VARCHAR(255) NOT NULL,
    subject VARCHAR(500) NOT NULL,
    body TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'failed')),
    ses_message_id VARCHAR(255),
    scheduled_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    opened_at TIMESTAMPTZ,
    clicked_at TIMESTAMPTZ,
    bounced_at TIMESTAMPTZ,
    bounce_type VARCHAR(20),
    soft_bounce_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_email_sends_campaign_target ON email_sends(campaign_id, target_id)
    WHERE campaign_id IS NOT NULL AND target_id IS NOT NULL AND status NOT IN ('failed', 'bounced');

ALTER TABLE email_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_sends_tenant ON email_sends
    USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Engagement Events
CREATE TABLE engagement_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    send_id UUID NOT NULL REFERENCES email_sends(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL
        CHECK (event_type IN ('sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained')),
    occurred_at TIMESTAMPTZ NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE engagement_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY engagement_events_tenant ON engagement_events
    USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Agent Sessions (for Maven session resume)
CREATE TABLE agent_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    agent_type VARCHAR(50) NOT NULL,
    maven_session_id VARCHAR(255),
    session_data JSONB NOT NULL CHECK (
        jsonb_typeof(session_data) = 'object' AND
        session_data ? 'type'
    ),
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'failed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_sessions_tenant ON agent_sessions
    USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Record migration
INSERT INTO schema_migrations (version, description)
VALUES ('001', 'Initial schema - organizations, targets, content, campaigns, email_sends');

COMMIT;
