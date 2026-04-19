-- Admin deposit search by cheque ref
CREATE INDEX IF NOT EXISTS idx_deposits_cheque_ref ON deposits(cheque_ref);
CREATE INDEX IF NOT EXISTS idx_deposits_created_at ON deposits(created_at);

-- Admin withdrawal date filter
CREATE INDEX IF NOT EXISTS idx_withdrawals_created_at ON withdrawals(created_at);

-- Game rounds date filter
CREATE INDEX IF NOT EXISTS idx_rounds_crashed_at ON game_rounds(crashed_at);

-- Bets lookup by round (for live feed)
CREATE INDEX IF NOT EXISTS idx_bets_round_status ON bets(round_id, status);
