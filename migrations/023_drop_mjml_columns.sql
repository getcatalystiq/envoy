-- Migration: 023_drop_mjml_columns
-- Description: Remove legacy MJML columns now that we only use email-builder-js

-- Drop mjml_source column (no longer used - all templates use builder_content)
ALTER TABLE design_templates DROP COLUMN IF EXISTS mjml_source;

-- Drop editor_type column (no longer needed - all templates are email_builder type)
ALTER TABLE design_templates DROP COLUMN IF EXISTS editor_type;
