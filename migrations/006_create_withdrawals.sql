CREATE TABLE IF NOT EXISTS withdrawals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES users(id),
  amount         NUMERIC(18,2) NOT NULL,
  payment_method VARCHAR(20) NOT NULL,
  card_number    VARCHAR(20) NOT NULL,
  status         VARCHAR(20) DEFAULT 'pending',
  admin_note     TEXT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  processed_at   TIMESTAMPTZ,
  processed_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
