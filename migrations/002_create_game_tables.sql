CREATE TABLE IF NOT EXISTS game_tables (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(50) NOT NULL,
  status     VARCHAR(20) DEFAULT 'waiting',
  created_at TIMESTAMPTZ DEFAULT now()
);
