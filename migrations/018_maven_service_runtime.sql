-- Migration: 018_maven_service_runtime.sql
-- Add service runtime ARN for IAM-authenticated Maven agent calls

ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS maven_service_runtime_arn TEXT;

COMMENT ON COLUMN organizations.maven_service_runtime_arn IS 'ARN of the IAM-authenticated Maven runtime for this tenant';
