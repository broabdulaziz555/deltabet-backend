# DeltaBet Backend

Aviator-style crash game platform — Node.js + Express + TypeScript + Prisma + PostgreSQL + Redis + Socket.io

## Stack
- **Runtime**: Node.js 20
- **Framework**: Express + TypeScript
- **Database**: PostgreSQL via Prisma ORM
- **Cache/PubSub**: Redis (ioredis)
- **Realtime**: Socket.io
- **Auth**: JWT (separate secrets for users and admins)
- **Deploy**: Railway.app (Docker)

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Copy env file and fill in values
cp .env.example .env

# 3. Run database migrations
npm run db:migrate

# 4. Seed first admin (admin / changeme123)
npm run seed:admin

# 5. Start dev server
npm run dev
```

## Deploy to Railway

1. Push this repo to GitHub
2. Create new Railway project → Deploy from GitHub repo
3. Add Railway Postgres add-on → DATABASE_URL auto-set
4. Add Railway Redis add-on → REDIS_URL auto-set
5. Set environment variables in Railway dashboard (see .env.example)
6. After first deploy, run via Railway console:
   ```
   npx prisma migrate deploy
   npm run seed:admin
   ```

## Environment Variables

| Variable | Description |
|---|---|
| DATABASE_URL | Railway Postgres connection string |
| REDIS_URL | Railway Redis connection string |
| JWT_SECRET | 64-char random hex (openssl rand -hex 32) |
| ADMIN_JWT_SECRET | Different 64-char random hex |
| GAME_MASTER_SECRET | Random secret for seed generation |
| CORS_ORIGINS | Comma-separated allowed origins |
| PORT | App port (default 3000) |

## API Endpoints

### Public
- `GET /health` — Health check
- `POST /api/auth/register` — Register (username + password)
- `POST /api/auth/login` — Login
- `GET /api/game/state` — Current game state
- `GET /api/game/history` — Round history
- `GET /api/game/top-wins` — Top wins feed
- `GET /api/game/multiplier-history` — Last 20 crash points

### Authenticated (Bearer JWT)
- `GET /api/auth/me` — Current user
- `POST /api/game/bet` — Place bet
- `POST /api/game/cashout` — Cash out
- `GET /api/game/my-bets` — My bet history
- `GET /api/game/live-bets` — Live bets current round
- `POST /api/wallet/deposit/init` — Init deposit (returns P2P card)
- `POST /api/wallet/deposit/cheque/:id` — Upload cheque file
- `POST /api/wallet/withdraw` — Request withdrawal
- `GET /api/wallet/transactions` — Transaction history
- `GET /api/wallet/balance` — Current balance
- `GET /api/wallet/bonus-grants` — Active bonus grants
- `POST /api/bonus/apply` — Apply promo code
- `GET /api/bonus/validate/:code` — Validate promo code
- `GET /api/user/profile` — User profile
- `GET /api/user/referrals` — Referral stats

### Admin (Bearer Admin JWT)
- All under `/api/admin/*` — See routes/admin.ts for full list

## WebSocket Events

Connect: `io('/', { auth: { token: 'JWT_TOKEN' } })`

### Server → Client
| Event | Data | Description |
|---|---|---|
| `game:state` | `{ state, roundId, multiplier }` | On connect |
| `game:waiting` | `{ roundId, serverSeedHash, countdown }` | New round starting |
| `game:start` | `{ roundId }` | Flying phase started |
| `game:multiplier` | `{ multiplier, elapsedMs }` | Every 100ms |
| `game:crash` | `{ crashPoint, roundId }` | Round crashed |
| `game:bet_placed` | `{ username, amount, panelSlot }` | Someone placed bet |
| `game:cashout` | `{ username, multiplier, winAmount }` | Someone cashed out |
| `chat:message` | `{ id, username, message, createdAt }` | New chat message |
| `chat:history` | `[messages]` | On connect |
| `wallet:balance:update` | `{ userId }` | Balance changed (fetch /api/wallet/balance) |

### Client → Server
| Event | Data |
|---|---|
| `chat:send` | `{ message: string }` |
| `wallet:balance` | (request current balance) |

## Admin Panel

Access: `https://yourdomain.com/adminpanel`
Default login: `admin` / `changeme123` — **change immediately**

## Account Types

- **REAL**: Normal players, 5% house edge, real money
- **DEMO**: Same UI, boosted win algorithm (~3.5x avg), balance resets daily to 500,000 UZS

## Game Algorithm

- **Real**: HMAC-SHA256(serverSeed, clientSeed:nonce) → 5% house edge
- **Demo**: Same but with 1.8-2.2x boost multiplier, lower forced-crash frequency
- Demo users get auto-cashedout just before real crash point if demo crash point is higher

## Payment Flow

1. User requests deposit → random P2P card selected from pool
2. User uploads cheque photo → pending transaction created
3. Admin approves → user balance credited + promo bonus applied
4. Admin rejects → transaction closed, card daily limit refunded

## Referral System

- Each user has unique referral code
- 30% of house profit from referred user's losses → credited to referrer
- Referral ownership transferable: if user applies new promo/referral code, profit share moves to new referrer
