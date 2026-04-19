# DeltaBet API Documentation

Base URL: `https://your-railway-app.railway.app`  
WebSocket: `wss://your-railway-app.railway.app/ws?token=ACCESS_TOKEN`

All protected routes require: `Authorization: Bearer <accessToken>`

---

## Authentication

| Method | Path | Body | Auth |
|--------|------|------|------|
| POST | `/api/auth/register` | `{username, password, lang?}` | ❌ |
| POST | `/api/auth/login` | `{username, password}` | ❌ |
| POST | `/api/auth/refresh` | `{refreshToken}` | ❌ |
| GET  | `/api/auth/me` | — | ✅ |
| PUT  | `/api/auth/change-credentials` | `{currentPassword, newUsername?, newPassword?}` | ✅ |
| POST | `/api/auth/telegram` | `{initData}` | ❌ |

**Register response:**
```json
{
  "user": { "id": "uuid", "username": "...", "lang": "ru", "balance": "0.00", "credit": "0.00" },
  "accessToken": "...",
  "refreshToken": "..."
}
```

---

## Wallet

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/wallet` | ✅ |
| GET | `/api/wallet/history?page=1&limit=20&type=bet` | ✅ |

---

## Deposits

| Method | Path | Body |
|--------|------|------|
| POST | `/api/deposits` | `{amount, paymentMethod, chequeRef, promoCode?}` |
| GET  | `/api/deposits?page=1` | — |

- `paymentMethod`: `"humo"` or `"uzcard"`
- `amount`: minimum 10,000 soums
- Status after submit: `pending` (balance NOT credited yet — admin must approve)

---

## Withdrawals

| Method | Path | Body |
|--------|------|------|
| POST | `/api/withdrawals` | `{amount, paymentMethod, cardNumber}` |
| GET  | `/api/withdrawals?page=1` | — |

- `amount`: minimum 50,000, maximum 15,000,000
- Balance deducted immediately on submit; refunded if admin rejects

---

## Promo

| Method | Path | Body |
|--------|------|------|
| POST | `/api/promo/validate` | `{code, depositAmount}` |

Returns bonus preview without applying it.

---

## Game (HTTP)

| Method | Path | Notes |
|--------|------|-------|
| GET  | `/api/game/tables` | All tables with live state |
| GET  | `/api/game/tables/:id/history?limit=50` | Crash history |
| GET  | `/api/game/rounds/:id` | Round details; `seed` only revealed after crash |
| POST | `/api/game/bet` | `{tableId, amount, currencyType}` |
| POST | `/api/game/cashout` | `{tableId}` |
| GET  | `/api/game/my-bets?page=1` | User's bet history |

- `currencyType`: `"balance"` or `"credit"`
- Betting only during `betting` phase; cashout only during `flying` phase

---

## WebSocket Protocol

**Connect:** `wss://domain/ws?token=ACCESS_TOKEN`

### Server → Client

```json
// On connect
{"type":"CONNECTED","tables":[...],"history":[{"table_id":1,"crash_point":2.31,...}]}

// Personal wallet state
{"type":"BALANCE_UPDATE","balance":"50000.00","credit":"10000.00"}

// Game events (broadcast to all)
{"type":"ROUND_START","tableId":1,"roundId":"uuid","seedHash":"abc...","bettingEndsAt":1234567890}
{"type":"BETTING_CLOSED","tableId":1}
{"type":"TICK","tableId":1,"multiplier":1.47,"elapsed":3200}
{"type":"CASHOUT_EVENT","tableId":1,"userId":"uuid","username":"player1","multiplier":1.47,"payout":7350,"amount":5000}
{"type":"CRASH","tableId":1,"crashPoint":2.31,"seed":"abc...","roundId":"uuid"}
{"type":"BET_PLACED","tableId":1,"userId":"uuid","username":"player1","amount":5000}

// Confirmations (personal)
{"type":"BET_CONFIRMED","betId":"uuid","tableId":1,"amount":5000}
{"type":"CASHOUT_CONFIRMED","tableId":1,"multiplier":1.47,"payout":7350}
{"type":"PONG","ts":1234567890}

// Errors
{"type":"ERROR","code":"RATE_LIMIT","message":"Too many messages"}
{"type":"ERROR","code":"ACTION_FAILED","message":"Not in betting phase"}
```

### Client → Server

```json
{"type":"PING"}
{"type":"BET","tableId":1,"amount":5000,"currencyType":"balance"}
{"type":"CASHOUT","tableId":1}
```

---

## Admin API

All `/admin/*` routes require: `Authorization: Bearer <adminToken>`

### Login
```
POST /admin/login   {username, password} → {token}
```

### Users
```
GET    /admin/users?search=&page=1&limit=20
GET    /admin/users/:id
PATCH  /admin/users/:id/account-type    {accountType:"real"|"demo"}
PATCH  /admin/users/:id/ban             {reason}
PATCH  /admin/users/:id/unban
PATCH  /admin/users/:id/balance         {type:"add"|"deduct",amount,currency:"balance"|"credit",note}
GET    /admin/users/:id/ledger
GET    /admin/users/:id/bets
```

### Deposits
```
GET    /admin/deposits?status=pending&userId=&page=1
GET    /admin/deposits/:id
PATCH  /admin/deposits/:id/approve    {amountActual}
PATCH  /admin/deposits/:id/reject     {note}
```

### Withdrawals
```
GET    /admin/withdrawals?status=pending&page=1
PATCH  /admin/withdrawals/:id/approve
PATCH  /admin/withdrawals/:id/reject   {note}
```

### Promos
```
GET    /admin/promos?page=1
POST   /admin/promos   {code,description,maxUses?,expiresAt?,tiers:[{minDeposit,bonusType,bonusValue}]}
PATCH  /admin/promos/:id   {description?,isActive?,maxUses?,expiresAt?}
DELETE /admin/promos/:id/deactivate
GET    /admin/promos/:id/stats
POST   /admin/promos/:id/tiers   {minDeposit,bonusType,bonusValue}
DELETE /admin/promos/:id/tiers/:tierId
```

`bonusType`: `"percent"` (e.g. bonusValue=200 → 200% of deposit added as credit) or `"fixed"` (flat amount)

### Stats & Logs
```
GET /admin/stats/overview
GET /admin/stats/revenue?from=2024-01-01&to=2024-12-31
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

## System Endpoints

```
GET /health        → {status,uptime,dbConnected,tables,timestamp}
GET /adminpanel?key=ADMIN_SECRET_KEY
```
