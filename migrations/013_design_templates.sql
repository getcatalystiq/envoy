-- Migration 013: Design Templates
-- Purpose: Email design template system for consistent branding

-- Design templates table
CREATE TABLE IF NOT EXISTS design_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    mjml_source TEXT NOT NULL,
    html_compiled TEXT,
    archived BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add template reference to content table
ALTER TABLE content ADD COLUMN IF NOT EXISTS design_template_id UUID REFERENCES design_templates(id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_design_templates_org ON design_templates(organization_id);
CREATE INDEX IF NOT EXISTS idx_design_templates_org_archived ON design_templates(organization_id, archived);

-- Enable Row-Level Security
ALTER TABLE design_templates ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Organization isolation
DROP POLICY IF EXISTS design_templates_org_isolation ON design_templates;
CREATE POLICY design_templates_org_isolation ON design_templates
    USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_design_templates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_design_templates_updated_at ON design_templates;
CREATE TRIGGER trigger_design_templates_updated_at
    BEFORE UPDATE ON design_templates
    FOR EACH ROW
    EXECUTE FUNCTION update_design_templates_updated_at();

COMMENT ON TABLE design_templates IS 'MJML-based email design templates for consistent branding';
COMMENT ON COLUMN design_templates.mjml_source IS 'MJML source code for the template';
COMMENT ON COLUMN design_templates.html_compiled IS 'Pre-compiled HTML from MJML source';
