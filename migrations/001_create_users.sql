CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      VARCHAR(32) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  account_type  VARCHAR(10) NOT NULL DEFAULT 'real',
  lang          VARCHAR(5) NOT NULL DEFAULT 'ru',
  balance       NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit        NUMERIC(18,2) NOT NULL DEFAULT 0,
  is_banned     BOOLEAN NOT NULL DEFAULT false,
  ban_reason    TEXT,
  telegram_id   BIGINT UNIQUE,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
