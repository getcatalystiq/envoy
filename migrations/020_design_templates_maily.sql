-- Migration 020: Add maily editor support to design templates
-- Purpose: Support both MJML and Maily editor types for design templates

-- Add editor_type column to track which editor was used
ALTER TABLE design_templates ADD COLUMN IF NOT EXISTS editor_type VARCHAR(20) DEFAULT 'mjml';

-- Add maily_content column for Maily editor JSON content
ALTER TABLE design_templates ADD COLUMN IF NOT EXISTS maily_content JSONB;

-- Make mjml_source nullable since Maily editor doesn't use MJML (if column exists)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'design_templates' AND column_name = 'mjml_source') THEN
        ALTER TABLE design_templates ALTER COLUMN mjml_source DROP NOT NULL;
    END IF;
END $$;

-- Comments only if columns exist
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'design_templates' AND column_name = 'editor_type') THEN
        COMMENT ON COLUMN design_templates.editor_type IS 'Editor type: mjml or maily';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'design_templates' AND column_name = 'maily_content') THEN
        COMMENT ON COLUMN design_templates.maily_content IS 'JSON content from Maily editor';
    END IF;
END $$;
