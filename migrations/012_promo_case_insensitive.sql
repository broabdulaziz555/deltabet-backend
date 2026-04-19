-- Case-insensitive unique index on promo code
-- Prevents duplicates like 'WELCOME' and 'welcome' being both inserted
DROP INDEX IF EXISTS promo_codes_code_key;

-- Replace simple unique with case-insensitive unique
CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_codes_code_upper
  ON promo_codes (UPPER(code));

-- Also add index for faster case-insensitive lookup
CREATE INDEX IF NOT EXISTS idx_promo_codes_active
  ON promo_codes (is_active, expires_at)
  WHERE is_active = true;
