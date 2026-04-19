CREATE TABLE IF NOT EXISTS promo_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        VARCHAR(50) UNIQUE NOT NULL,
  description TEXT,
  is_active   BOOLEAN DEFAULT true,
  max_uses    INTEGER,
  used_count  INTEGER DEFAULT 0,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promo_tiers (
  id          SERIAL PRIMARY KEY,
  promo_id    UUID REFERENCES promo_codes(id) ON DELETE CASCADE,
  min_deposit NUMERIC(18,2) NOT NULL,
  bonus_type  VARCHAR(10) NOT NULL,
  bonus_value NUMERIC(18,2) NOT NULL,
  sort_order  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS promo_uses (
  id         SERIAL PRIMARY KEY,
  promo_id   UUID REFERENCES promo_codes(id),
  user_id    UUID REFERENCES users(id),
  deposit_id UUID REFERENCES deposits(id),
  bonus_given NUMERIC(18,2),
  used_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(promo_id, user_id)
);
