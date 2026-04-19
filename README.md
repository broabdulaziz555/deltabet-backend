# DeltaBet Backend

Aviator-style crash betting platform. Node.js + Express + WebSocket + PostgreSQL.
Railway-deployable in a single `npm start`.

---

## Quick Deploy to Railway

1. Fork / push this repo to GitHub
2. New Railway project → **Deploy from GitHub repo**
3. Add **PostgreSQL** plugin → `DATABASE_URL` auto-injected
4. Set environment variables (copy `.env.example`):

| Variable | Required | Notes |
|----------|----------|-------|
| `DATABASE_URL` | Auto | Set by Railway PostgreSQL |
| `JWT_SECRET` | ✅ | Min 32 chars |
| `JWT_REFRESH_SECRET` | ✅ | Min 32 chars |
| `ADMIN_USERNAME` | ✅ | Admin login |
| `ADMIN_PASSWORD` | ✅ | Admin login |
| `ADMIN_JWT_SECRET` | ✅ | Min 16 chars |
| `ADMIN_SECRET_KEY` | ✅ | Panel gate key |
| `ALLOWED_ORIGINS` | ✅ | Your frontend URLs, comma-separated |
| `TELEGRAM_BOT_TOKEN` | ❌ | Only if using Telegram Web App |

5. Railway runs: `npm run migrate && npm start` automatically

---

## Local Development

```bash
cp .env.example .env
# Edit .env — set DATABASE_URL to your local Postgres

npm install
npm run migrate
npm run dev
```

---

## Architecture

```
HTTP + WS server (single port)
│
├── REST API (/api/*)
│   ├── /auth    — register, login, refresh, me, change-credentials, telegram
│   ├── /wallet  — balance, ledger
│   ├── /deposits   — submit, history
│   ├── /withdrawals — submit, history
│   ├── /promo   — validate promo preview
│   └── /game    — tables, history, rounds, bet, cashout, my-bets
│
├── Admin API (/admin/*)
│   ├── users, deposits, withdrawals, promos
│   └── stats, logs, game control
│
└── WebSocket (/ws?token=...)
    ├── Auth on connect (JWT via query param)
    ├── Real-time: TICK, ROUND_START, CRASH, CASHOUT_EVENT, BET_PLACED
    └── Personal: BALANCE_UPDATE, BET_CONFIRMED, CASHOUT_CONFIRMED
```

## Game State Machine

```
BETTING (7s) → FLYING (exponential multiplier) → CRASHED (3s cooldown) → BETTING ...
```

- Crash point generated **server-side** before round starts
- Only `seedHash` (SHA256 of seed) broadcast during betting — crash point hidden
- Full `seed` revealed after crash for **provably fair** verification
- Demo accounts: server silently auto-cashes out at 1.05x–1.20x (~91% win rate)
- Real accounts: 5% house edge via crash distribution

## Security

- All game state server-authoritative — client never sends multiplier values
- Atomic DB transactions on bet placement and cashout
- Race condition guard (`pendingBets`) prevents double-bet from concurrent requests
- Parameterized queries throughout — no SQL injection surface
- JWT access (24h) + refresh (30d) tokens; separate admin JWT secret
- Rate limiting: auth 10/min, API 60/min, admin 30/min, WS 5msg/s
- Timing-safe password comparison (prevents user enumeration)
- Telegram initData validated with `timingSafeEqual`

## Clients

Any client connecting to this backend:
- **Web app (Next.js/Vercel):** REST + WS, set `ALLOWED_ORIGINS`
- **Telegram Web App:** POST `/api/auth/telegram` with `initData` → get JWT → REST + WS
- **Android/iOS (native):** No `Origin` header → always allowed through CORS
- **Future:** Same backend, no changes required
