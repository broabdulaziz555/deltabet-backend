CREATE TABLE IF NOT EXISTS deposits (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES users(id),
  amount_claimed NUMERIC(18,2) NOT NULL,
  amount_actual  NUMERIC(18,2),
  payment_method VARCHAR(20) NOT NULL,
  cheque_ref     TEXT,
  promo_code     VARCHAR(50),
  status         VARCHAR(20) DEFAULT 'pending',
  admin_note     TEXT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  processed_at   TIMESTAMPTZ,
  processed_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_deposits_user_id ON deposits(user_id);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
