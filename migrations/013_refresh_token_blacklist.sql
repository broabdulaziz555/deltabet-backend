-- Revoked refresh tokens (for logout / token invalidation)
CREATE TABLE IF NOT EXISTS refresh_token_blacklist (
  token_hash  TEXT PRIMARY KEY,    -- SHA256 of the refresh token
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  revoked_at  TIMESTAMPTZ DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL -- auto-cleanup possible via pg cron
);

CREATE INDEX IF NOT EXISTS idx_rtb_expires ON refresh_token_blacklist(expires_at);
