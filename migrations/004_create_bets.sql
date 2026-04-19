CREATE TABLE IF NOT EXISTS bets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id),
  round_id      UUID REFERENCES game_rounds(id),
  table_id      INTEGER REFERENCES game_tables(id),
  amount        NUMERIC(18,2) NOT NULL,
  currency_type VARCHAR(10) NOT NULL DEFAULT 'balance',
  cashout_at    NUMERIC(10,2),
  payout        NUMERIC(18,2) DEFAULT 0,
  status        VARCHAR(20) DEFAULT 'active',
  placed_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bets_user_id ON bets(user_id);
CREATE INDEX IF NOT EXISTS idx_bets_round_id ON bets(round_id);
CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status);
