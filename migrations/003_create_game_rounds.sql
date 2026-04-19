CREATE TABLE IF NOT EXISTS game_rounds (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id    INTEGER REFERENCES game_tables(id),
  crash_point NUMERIC(10,2) NOT NULL,
  started_at  TIMESTAMPTZ,
  crashed_at  TIMESTAMPTZ,
  status      VARCHAR(20) DEFAULT 'pending',
  seed        TEXT NOT NULL,
  seed_hash   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rounds_table_id ON game_rounds(table_id);
CREATE INDEX IF NOT EXISTS idx_rounds_status ON game_rounds(status);
