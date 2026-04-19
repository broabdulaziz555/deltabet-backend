export const LIMITS = {
  MIN_DEPOSIT:     10_000,
  MIN_WITHDRAWAL:  50_000,
  MAX_TRANSACTION: 15_000_000,
  USERNAME_MIN: 8,
  USERNAME_MAX: 32,
  PASSWORD_MIN: 8,
  PASSWORD_MAX: 32,
} as const;

export const PAYMENT_METHODS = ['humo', 'uzcard'] as const;
export type PaymentMethod = typeof PAYMENT_METHODS[number];

export const ACCOUNT_TYPES = { REAL: 'real', DEMO: 'demo' } as const;
export type AccountType = typeof ACCOUNT_TYPES[keyof typeof ACCOUNT_TYPES];

// Single currency: UZS
// balance = real deposited money (withdrawable)
// credit  = bonus money (non-withdrawable, awarded via promo)
// Both denominated in Uzbek soums.
export const CURRENCY = { BALANCE: 'balance', CREDIT: 'credit' } as const;
export type Currency = typeof CURRENCY[keyof typeof CURRENCY];

export const LANGS = ['en', 'ru', 'uz'] as const;
export type Lang = typeof LANGS[number];

export const LEDGER_TYPES = {
  DEPOSIT:        'deposit',
  WITHDRAWAL:     'withdrawal',
  BET:            'bet',
  WIN:            'win',
  DEPOSIT_BONUS:  'deposit_bonus',  // promo credit bonus
  ADMIN_ADD:      'admin_add',
  ADMIN_DEDUCT:   'admin_deduct',
  REFUND:         'refund',
} as const;

export const GAME = {
  BETTING_PHASE_MS:  7_000,
  TICK_MS:           100,
  MAX_MULTIPLIER:    1_000,
  HOUSE_EDGE_REAL:   0.05,
  MIN_BET:           2_000,       // 2,000 soums minimum
  MAX_BET:           5_000_000,
  MAX_BETS_PER_USER: 2,           // max simultaneous bet panels per user per round
  CRASH_COOLDOWN_MS: 3_000,
} as const;
