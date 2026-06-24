-- U1 — per-sequence agent config. Adds an OPTIONAL agent override to the sequence DEFINITION so the
-- drip engine resolves a different Anthropic agent per sequence, instead of one global config
-- (lib host previously set a single `envoy.config.agent`). The value is `{agentId, environmentId,
-- vaultId?}` JSONB, mirroring how `steps` is stored. NULL = no per-sequence agent.
--
-- RE-RUN-SAFE: ADD COLUMN IF NOT EXISTS only (host runners re-run every migration each deploy, per
-- 002's contract). No DEFAULT (nullable), no index — the column is read with the row, never queried
-- by content.
--
-- CUTOVER NOTE: the old (pre-agent) engine ignores this column, so a host may seed an existing
-- sequence's agent_config here BEFORE deploying the agent-aware engine — no gap. (Plan U9.)

ALTER TABLE sdk_sequence_defs ADD COLUMN IF NOT EXISTS agent_config JSONB;
ALTER TABLE sdk_sequence_def_history ADD COLUMN IF NOT EXISTS agent_config JSONB;
