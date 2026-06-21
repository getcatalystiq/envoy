CREATE TABLE IF NOT EXISTS sdk_contacts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    namespace TEXT NOT NULL,
    email TEXT NOT NULL,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    resend_contact_id TEXT,
    unsubscribed BOOLEAN NOT NULL DEFAULT FALSE,
    dirty_since TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (namespace, email)
);

CREATE INDEX IF NOT EXISTS sdk_contacts_dirty_idx
    ON sdk_contacts (namespace, dirty_since)
    WHERE dirty_since IS NOT NULL;

CREATE TABLE IF NOT EXISTS sdk_topic_consent (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    namespace TEXT NOT NULL,
    contact TEXT NOT NULL,
    topic_key TEXT NOT NULL,
    topic_id TEXT,
    digest_status TEXT NOT NULL DEFAULT 'opt_in',
    alert_status TEXT NOT NULL DEFAULT 'opt_in',
    resend_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    dirty_since TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (namespace, contact, topic_key)
);

CREATE INDEX IF NOT EXISTS sdk_topic_consent_dirty_idx
    ON sdk_topic_consent (namespace, dirty_since)
    WHERE dirty_since IS NOT NULL;

CREATE TABLE IF NOT EXISTS sdk_program_state (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    namespace TEXT NOT NULL,
    program_key TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    watermark TEXT,
    issue_seq BIGINT NOT NULL DEFAULT 0,
    last_fired_at TIMESTAMPTZ,
    paused BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (namespace, program_key, subject_key)
);

CREATE TABLE IF NOT EXISTS sdk_broadcast_claims (
    namespace TEXT NOT NULL,
    broadcast_key TEXT NOT NULL,
    resend_broadcast_id TEXT,
    item_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (namespace, broadcast_key)
);

CREATE TABLE IF NOT EXISTS sdk_enrollments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    namespace TEXT NOT NULL,
    contact TEXT NOT NULL,
    sequence_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    current_step INTEGER NOT NULL DEFAULT 0,
    next_run_at TIMESTAMPTZ,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (namespace, contact, sequence_key)
);

CREATE INDEX IF NOT EXISTS sdk_enrollments_due_idx
    ON sdk_enrollments (namespace, status, next_run_at);

CREATE TABLE IF NOT EXISTS sdk_steps (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    namespace TEXT NOT NULL,
    enrollment_id BIGINT NOT NULL REFERENCES sdk_enrollments (id) ON DELETE CASCADE,
    step_index INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    agent_session_id TEXT,
    resend_email_id TEXT,
    sent_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (namespace, enrollment_id, step_index)
);

CREATE INDEX IF NOT EXISTS sdk_steps_enrollment_idx
    ON sdk_steps (namespace, enrollment_id);

-- Fixed-window rate-limit counters (U6 unsubscribe landing). Serverless-safe: in-memory
-- counters do not survive across function invocations, so the limiter is DB-backed. `key` is
-- already namespace-prefixed by the caller (the unsubscribe landing buckets per client IP).
CREATE TABLE IF NOT EXISTS sdk_rate_limits (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (namespace, key)
);
