-- Migration: Create sequence system tables
-- Purpose: Multi-step customer journeys with AI-personalized content

BEGIN;

-- Check if migration already applied
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '013') THEN
        RAISE EXCEPTION 'Migration 013 already applied';
    END IF;
END $$;

-- =============================================================================
-- SEQUENCES TABLE
-- Template defining the journey for a target_type
-- =============================================================================
CREATE TABLE sequences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    target_type_id UUID NOT NULL REFERENCES target_types(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sequences_organization ON sequences (organization_id);
CREATE INDEX idx_sequences_target_type ON sequences (organization_id, target_type_id);
CREATE UNIQUE INDEX idx_sequences_org_name ON sequences (organization_id, name);

ALTER TABLE sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY sequences_tenant ON sequences
    USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- =============================================================================
-- SEQUENCE_STEPS TABLE
-- Individual touchpoints in the sequence
-- =============================================================================
CREATE TABLE sequence_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence_id UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    default_delay_hours INTEGER NOT NULL DEFAULT 24,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (sequence_id, position)
);

CREATE INDEX idx_sequence_steps_organization ON sequence_steps (organization_id);
CREATE INDEX idx_sequence_steps_sequence ON sequence_steps (sequence_id, position);

ALTER TABLE sequence_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY sequence_steps_tenant ON sequence_steps
    USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- =============================================================================
-- SEQUENCE_STEP_CONTENTS TABLE
-- Pool of content options for a step (priority-based selection)
-- =============================================================================
CREATE TABLE sequence_step_contents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence_step_id UUID NOT NULL REFERENCES sequence_steps(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    content_id UUID NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    priority INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (sequence_step_id, content_id)
);

CREATE INDEX idx_sequence_step_contents_organization ON sequence_step_contents (organization_id);
CREATE INDEX idx_sequence_step_contents_step ON sequence_step_contents (sequence_step_id, priority);

ALTER TABLE sequence_step_contents ENABLE ROW LEVEL SECURITY;

CREATE POLICY sequence_step_contents_tenant ON sequence_step_contents
    USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- =============================================================================
-- SEQUENCE_ENROLLMENTS TABLE
-- A target's journey through a sequence
-- =============================================================================
CREATE TABLE sequence_enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    sequence_id UUID NOT NULL REFERENCES sequences(id) ON DELETE RESTRICT,
    current_step_position INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'completed', 'converted', 'exited')),
    exit_reason VARCHAR(50),
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_step_completed_at TIMESTAMPTZ,
    next_evaluation_at TIMESTAMPTZ,
    paused_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prevent duplicate active enrollments per target per sequence
CREATE UNIQUE INDEX idx_enrollments_active_unique
    ON sequence_enrollments (target_id, sequence_id)
    WHERE status IN ('active', 'paused');

-- For evaluation loop queries (scheduler)
CREATE INDEX idx_enrollments_next_eval
    ON sequence_enrollments (next_evaluation_at)
    WHERE status = 'active';

CREATE INDEX idx_enrollments_organization ON sequence_enrollments (organization_id);
CREATE INDEX idx_enrollments_target ON sequence_enrollments (organization_id, target_id);
CREATE INDEX idx_enrollments_sequence ON sequence_enrollments (organization_id, sequence_id);

ALTER TABLE sequence_enrollments ENABLE ROW LEVEL SECURITY;

CREATE POLICY sequence_enrollments_tenant ON sequence_enrollments
    USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- =============================================================================
-- SEQUENCE_STEP_EXECUTIONS TABLE
-- Immutable record of what happened at each step
-- =============================================================================
CREATE TABLE sequence_step_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    enrollment_id UUID NOT NULL REFERENCES sequence_enrollments(id) ON DELETE CASCADE,
    step_position INTEGER NOT NULL,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    email_send_id UUID REFERENCES email_sends(id) ON DELETE SET NULL,
    content_id UUID REFERENCES content(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'executed'
        CHECK (status IN ('executed', 'skipped')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_step_executions_organization ON sequence_step_executions (organization_id);
CREATE INDEX idx_step_executions_enrollment ON sequence_step_executions (enrollment_id);

ALTER TABLE sequence_step_executions ENABLE ROW LEVEL SECURITY;

CREATE POLICY sequence_step_executions_tenant ON sequence_step_executions
    USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- =============================================================================
-- UPDATED_AT FUNCTION (if not exists)
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- UPDATED_AT TRIGGERS
-- =============================================================================
CREATE TRIGGER set_sequences_updated_at
    BEFORE UPDATE ON sequences
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_sequence_steps_updated_at
    BEFORE UPDATE ON sequence_steps
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_sequence_enrollments_updated_at
    BEFORE UPDATE ON sequence_enrollments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Record migration
INSERT INTO schema_migrations (version, description)
VALUES ('013', 'Sequence system - sequences, steps, enrollments, executions');

COMMIT;
