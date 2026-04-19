-- Ensure credit column exists (bonus UZS — non-withdrawable)
ALTER TABLE users ADD COLUMN IF NOT EXISTS credit NUMERIC(18,2) NOT NULL DEFAULT 0;

-- Ensure currency_type exists on bets (balance | credit)
ALTER TABLE bets ADD COLUMN IF NOT EXISTS currency_type VARCHAR(10) NOT NULL DEFAULT 'balance';

-- Admin logs index
CREATE INDEX IF NOT EXISTS idx_admin_logs_created_at ON admin_logs(created_at);
