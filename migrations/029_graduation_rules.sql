BEGIN;

-- Graduation rules table
CREATE TABLE graduation_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_target_type_id UUID NOT NULL REFERENCES target_types(id) ON DELETE RESTRICT,
    destination_target_type_id UUID NOT NULL REFERENCES target_types(id) ON DELETE RESTRICT,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    conditions JSONB NOT NULL DEFAULT '[]',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT graduation_rules_different_types
        CHECK (source_target_type_id != destination_target_type_id),
    CONSTRAINT graduation_rules_unique_name
        UNIQUE (organization_id, name)
);

-- Graduation events audit table
CREATE TABLE graduation_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    target_id UUID REFERENCES targets(id) ON DELETE SET NULL,
    rule_id UUID REFERENCES graduation_rules(id) ON DELETE SET NULL,
    source_target_type_id UUID NOT NULL,
    destination_target_type_id UUID NOT NULL,
    manual BOOLEAN NOT NULL DEFAULT FALSE,
    triggered_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_graduation_rules_lookup
    ON graduation_rules(organization_id, source_target_type_id, enabled)
    WHERE enabled = TRUE;

CREATE INDEX idx_graduation_events_target
    ON graduation_events(target_id)
    WHERE target_id IS NOT NULL;

CREATE INDEX idx_graduation_events_org_time
    ON graduation_events(organization_id, created_at DESC);

-- Trigger for updated_at
CREATE TRIGGER set_graduation_rules_updated_at
    BEFORE UPDATE ON graduation_rules
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
