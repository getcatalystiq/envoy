-- Fixed-window rate-limit counters for unauthenticated credential endpoints
-- (OAuth authorize/token/register). Keyed by "<bucket>:<identifier>" (e.g.
-- per-IP or per-email). A row's window resets when window_start ages out.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start
  ON rate_limits (window_start);
