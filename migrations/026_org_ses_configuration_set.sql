-- Add SES tenant and configuration set columns to organizations for email event tracking
-- Each org gets their own SES tenant with identity, configuration set, and SNS event destination

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ses_tenant_name VARCHAR(64),
  ADD COLUMN IF NOT EXISTS ses_configuration_set VARCHAR(255);

COMMENT ON COLUMN organizations.ses_tenant_name IS 'SES Tenant name for isolating email sending and reputation per org';
COMMENT ON COLUMN organizations.ses_configuration_set IS 'SES Configuration Set name for tracking email events (delivery, open, click, bounce)';
