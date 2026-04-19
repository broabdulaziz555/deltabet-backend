CREATE TABLE IF NOT EXISTS balance_ledger (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id),
  type          VARCHAR(30) NOT NULL,
  currency      VARCHAR(10) NOT NULL,
  amount        NUMERIC(18,2) NOT NULL,
  balance_after NUMERIC(18,2),
  ref_id        TEXT,
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_user_id ON balance_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_created_at ON balance_ledger(created_at);
