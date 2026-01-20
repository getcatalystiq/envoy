-- Migration: 023_drop_mjml_columns
-- Description: Remove legacy MJML columns now that we only use email-builder-js

-- Drop mjml_source column (no longer used - all templates use builder_content)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'design_templates' AND column_name = 'mjml_source') THEN
        ALTER TABLE design_templates DROP COLUMN mjml_source;
    END IF;
END $$;

-- Drop editor_type column (no longer needed - all templates are email_builder type)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'design_templates' AND column_name = 'editor_type') THEN
        ALTER TABLE design_templates DROP COLUMN editor_type;
    END IF;
END $$;
