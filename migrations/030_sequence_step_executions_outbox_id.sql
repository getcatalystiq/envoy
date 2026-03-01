-- Add outbox_id to sequence_step_executions to track which outbox item was created
-- This enables joining to email_sends through outbox for accurate open/click tracking

ALTER TABLE sequence_step_executions
ADD COLUMN outbox_id UUID REFERENCES outbox(id) ON DELETE SET NULL;

CREATE INDEX idx_step_executions_outbox_id ON sequence_step_executions(outbox_id)
WHERE outbox_id IS NOT NULL;
