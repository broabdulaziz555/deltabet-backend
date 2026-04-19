# DeltaBet API Documentation

Base URL: `https://your-railway-app.railway.app`
WebSocket: `wss://your-railway-app.railway.app/ws?token=ACCESS_TOKEN`

All protected routes require: `Authorization: Bearer <accessToken>`

---

## Auth

| Method | Path | Body | Auth |
|--------|------|------|------|
| POST | `/api/auth/register` | `{username, password, lang?}` | ❌ |
| POST | `/api/auth/login` | `{username, password}` | ❌ |
| POST | `/api/auth/refresh` | `{refreshToken}` | ❌ |
| POST | `/api/auth/logout` | `{refreshToken}` | ✅ |
| POST | `/api/auth/telegram` | `{initData}` | ❌ |
| GET  | `/api/auth/me` | — | ✅ |
| GET  | `/api/auth/me/stats` | — | ✅ |
| PUT  | `/api/auth/change-credentials` | `{currentPassword, newUsername?, newPassword?}` | ✅ |

**Username rules:** 8–32 characters, anything allowed.
**lang:** `"ru"` (default) | `"uz"` | `"en"`

**Register/Login response:**
```json
{
  "user": { "id": "uuid", "username": "...", "lang": "ru", "balance": "0.00", "credit": "0.00" },
  "accessToken": "eyJ...",
  "refreshToken": "eyJ..."
}
```

**me/stats response:**
```json
{
  "total_bets": 42,
  "bets_won": 18,
  "bets_lost": 24,
  "total_wagered": "420000.00",
  "total_won": "380000.00",
  "biggest_multiplier": "12.50",
  "biggest_payout": "125000.00",
  "net_profit": "-40000.00"
}
```

---

## Wallet

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/wallet` | ✅ |
| GET | `/api/wallet/history?page=1&limit=20&type=bet` | ✅ |

**Wallet response:** `{ balance: "50000.00", credit: "10000.00" }`
- `balance` = real UZS (deposited, withdrawable)
- `credit` = bonus UZS (from promos, non-withdrawable, can bet with it)

**Ledger types:** `deposit`, `withdrawal`, `bet`, `win`, `deposit_bonus`, `admin_add`, `admin_deduct`, `refund`

---

## Deposits

| Method | Path | Body | Auth |
|--------|------|------|------|
| POST | `/api/deposits` | `{amount, paymentMethod, chequeRef, promoCode?}` | ✅ |
| GET  | `/api/deposits?page=1&limit=20` | — | ✅ |

- `paymentMethod`: `"humo"` or `"uzcard"`
- Min deposit: **10,000 soums**
- Status after submit: `pending` (balance NOT credited yet — admin must approve)

---

## Withdrawals

| Method | Path | Body | Auth |
|--------|------|------|------|
| POST | `/api/withdrawals` | `{amount, paymentMethod, cardNumber}` | ✅ |
| GET  | `/api/withdrawals?page=1&limit=20` | — | ✅ |

- Min: **50,000 soums** | Max: **15,000,000 soums**
- Balance deducted immediately; refunded if admin rejects

---

## Promo

| Method | Path | Body | Auth |
|--------|------|------|------|
| POST | `/api/promo/validate` | `{code, depositAmount}` | ✅ |

Returns bonus preview without applying it.

---

## Game

| Method | Path | Notes | Auth |
|--------|------|-------|------|
| GET  | `/api/game/tables` | All tables with live state | ✅ |
| GET  | `/api/game/tables/:id/history?limit=50` | Crash history | ✅ |
| GET  | `/api/game/tables/:id/bets` | Live bet feed (All Bets panel) | ✅ |
| GET  | `/api/game/rounds/:id` | Round details; seed only after crash | ✅ |
| GET  | `/api/game/verify/:roundId` | Provably fair verification | ❌ |
| POST | `/api/game/bet` | Place a bet | ✅ |
| POST | `/api/game/cashout` | Cash out | ✅ |
| GET  | `/api/game/my-bets?page=1` | Bet history | ✅ |
| GET  | `/api/game/my-active-bets` | Active bets (reconnection recovery) | ✅ |

**Bet body:**
```json
{
  "tableId": 1,
  "amount": 10000,
  "currencyType": "balance",
  "panel": 0,
  "autoCashoutAt": 2.5
}
```
- `panel`: `0` or `1` — two independent bet panels per round
- `autoCashoutAt`: optional — server auto-cashes out when multiplier hits this
- Min bet: **2,000 soums** | Max: **5,000,000 soums**

**Cashout body:**
```json
{ "tableId": 1, "betId": "uuid" }
```
- `betId` optional — if omitted, cashes out all active panels

---

## WebSocket

**Connect:** `wss://domain/ws?token=ACCESS_TOKEN`
**Max 10 messages/second per user | Max 5 connections per IP**

### Server → Client

```
CONNECTED        {tables, liveBets, history}          on connect
BALANCE_UPDATE   {balance, credit}                     personal
ROUND_START      {tableId, roundId, seedHash, bettingEndsAt}
BETTING_CLOSED   {tableId}
TICK             {tableId, multiplier, elapsed}         every 100ms
CRASH            {tableId, crashPoint, seed, roundId}
COOLDOWN         {tableId, nextBettingAt, cooldownMs}   after crash
BET_PLACED       {tableId, userId, username, amount, panel, currencyType, autoCashoutAt}
CASHOUT_EVENT    {tableId, userId, username, multiplier, payout, amount, panel, betId}
BET_CONFIRMED    {betId, panel, tableId, amount, autoCashoutAt}   personal
CASHOUT_CONFIRMED {tableId, betId, panel, multiplier, payout}      personal
PONG             {ts}
ERROR            {code, message, reconnectAfter?}
```

### Client → Server

```json
{"type":"PING"}
{"type":"BET","tableId":1,"amount":10000,"currencyType":"balance","panel":0,"autoCashoutAt":2.5}
{"type":"CASHOUT","tableId":1,"betId":"uuid"}
```

---

## Admin API

All `/admin/*` routes require: `Authorization: Bearer <adminToken>`

### Login
```
POST /admin/login   {username, password}  →  {token}
```

### Users
```
GET    /admin/users?search=&page=1&limit=20
GET    /admin/users/online
GET    /admin/users/:id
PATCH  /admin/users/:id/account-type    {accountType:"real"|"demo"}
PATCH  /admin/users/:id/ban             {reason}
PATCH  /admin/users/:id/unban
PATCH  /admin/users/:id/balance         {type:"add"|"deduct", amount, note}
GET    /admin/users/:id/ledger?page=1
GET    /admin/users/:id/bets?page=1
```

### Deposits
```
GET    /admin/deposits?status=pending&userId=&chequeRef=&from=&to=&page=1
GET    /admin/deposits/:id
PATCH  /admin/deposits/:id/approve    {amountActual}
PATCH  /admin/deposits/:id/reject     {note}
```

### Withdrawals
```
GET    /admin/withdrawals?status=pending&from=&to=&page=1
PATCH  /admin/withdrawals/:id/approve
PATCH  /admin/withdrawals/:id/reject   {note}
```

### Promos
```
GET    /admin/promos?search=&isActive=true&page=1
GET    /admin/promos/:id
POST   /admin/promos   {code, description, maxUses?, expiresAt?, isActive, tiers:[]}
PATCH  /admin/promos/:id   {description?, isActive?, maxUses?, expiresAt?}
POST   /admin/promos/:id/toggle
DELETE /admin/promos/:id
POST   /admin/promos/:id/tiers   {minDeposit, bonusType, bonusValue}
PATCH  /admin/promos/:id/tiers/:tierId
DELETE /admin/promos/:id/tiers/:tierId
```

### Stats
```
GET /admin/stats/overview
GET /admin/stats/revenue?from=2025-01-01&to=2025-12-31
GET /admin/stats/users/top
GET /admin/stats/rounds?tableId=1&from=&to=&page=1
GET /admin/logs?page=1
```

### Game Control
```
GET  /admin/game/tables
POST /admin/game/tables/:id/pause
POST /admin/game/tables/:id/resume
```

---

## System
```
GET /health
GET /adminpanel?key=ADMIN_SECRET_KEY
```
