-- Add outbox_id to email_sends to track which outbox item created the send
ALTER TABLE email_sends ADD COLUMN outbox_id UUID REFERENCES outbox(id) ON DELETE SET NULL;

-- Index for looking up sends by outbox item
CREATE INDEX idx_email_sends_outbox_id ON email_sends(outbox_id) WHERE outbox_id IS NOT NULL;
