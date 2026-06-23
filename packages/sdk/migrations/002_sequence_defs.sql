-- U-S1 — DB-backed drip sequence DEFINITIONS (the host-editable store).
--
-- Until now the SDK persisted only enrollment/step STATE (001_core.sql); sequence DEFINITIONS lived
-- in host code via defineSequence. This migration adds the definition store so a host can edit a
-- sequence (steps / waitDays / aiSlots / brief) without a redeploy, fed back to the engine through a
-- DB-backed function-form SequenceRegistry (createDbSequenceRegistry, U-S2).
--
-- IDEMPOTENT / RE-RUN-SAFE: shipped SDK migrations are applied by host runners that re-run every
-- file on every deploy (e.g. easy-passport's scripts/envoy-migrate.mjs), so every statement is
-- `CREATE ... IF NOT EXISTS`. No functions / DO-blocks / dollar-quoted bodies / ALTER ADD CONSTRAINT.
--
-- NAMESPACING: `sequence_key` is stored BARE (namespace lives in the `namespace` column), matching
-- sdk_enrollments.sequence_key — the engine resolves the registry with the bare key, so a prefixed
-- key would silently break resolution for every live enrollment.

CREATE TABLE IF NOT EXISTS sdk_sequence_defs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    namespace TEXT NOT NULL,
    sequence_key TEXT NOT NULL,
    steps JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (namespace, sequence_key)
);

-- Append-only audit/history: one row per save (who / what / when), and the rollback source.
CREATE TABLE IF NOT EXISTS sdk_sequence_def_history (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    namespace TEXT NOT NULL,
    sequence_key TEXT NOT NULL,
    version INTEGER NOT NULL,
    actor TEXT,
    steps JSONB NOT NULL,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sdk_sequence_def_history_key_idx
    ON sdk_sequence_def_history (namespace, sequence_key, version);
