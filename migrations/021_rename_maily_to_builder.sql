-- Migration 021: Rename maily_content to builder_content for email-builder-js
-- Purpose: Replace Maily editor with email-builder-js

-- Rename the content column
ALTER TABLE design_templates RENAME COLUMN maily_content TO builder_content;

-- Update editor_type value from 'maily' to 'email_builder' for any existing rows
UPDATE design_templates SET editor_type = 'email_builder' WHERE editor_type = 'maily';

-- Update the default value for new templates
ALTER TABLE design_templates ALTER COLUMN editor_type SET DEFAULT 'email_builder';

COMMENT ON COLUMN design_templates.builder_content IS 'JSON content from email-builder-js editor (TReaderDocument format)';
COMMENT ON COLUMN design_templates.editor_type IS 'Editor type: mjml or email_builder';
