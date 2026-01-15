-- Migration 020: Add maily editor support to design templates
-- Purpose: Support both MJML and Maily editor types for design templates

-- Add editor_type column to track which editor was used
ALTER TABLE design_templates ADD COLUMN IF NOT EXISTS editor_type VARCHAR(20) DEFAULT 'mjml';

-- Add maily_content column for Maily editor JSON content
ALTER TABLE design_templates ADD COLUMN IF NOT EXISTS maily_content JSONB;

-- Make mjml_source nullable since Maily editor doesn't use MJML
ALTER TABLE design_templates ALTER COLUMN mjml_source DROP NOT NULL;

COMMENT ON COLUMN design_templates.editor_type IS 'Editor type: mjml or maily';
COMMENT ON COLUMN design_templates.maily_content IS 'JSON content from Maily editor';
