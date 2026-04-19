import { WebSocketServer, WebSocket, RawData } from 'ws';
import { IncomingMessage, Server }             from 'http';
import jwt                                     from 'jsonwebtoken';
import { env }                                 from '../config/env';
import { gameManager, TableLoop }              from './gameLoop';
import { pool }                                from '../db/pool';
import { logger }                              from '../utils/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthedWs extends WebSocket {
  userId:      string;
  username:    string;
  accountType: string;
  isAlive:     boolean;
}

type ClientMsg = { type?: string; [k: string]: unknown };

// ─── Connection registries ────────────────────────────────────────────────────

const userSockets   = new Map<string, Set<AuthedWs>>();
const allSockets    = new Set<AuthedWs>();
const ipConnections = new Map<string, number>(); // IP → active connection count
const MAX_CONN_PER_IP = 5;

function registerSocket(ws: AuthedWs) {
  allSockets.add(ws);
  if (!userSockets.has(ws.userId)) userSockets.set(ws.userId, new Set());
  userSockets.get(ws.userId)!.add(ws);
}

function unregisterSocket(ws: AuthedWs) {
  allSockets.delete(ws);
  const set = userSockets.get(ws.userId);
  if (set) { set.delete(ws); if (!set.size) userSockets.delete(ws.userId); }
}

function sendTo(ws: WebSocket, data: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(data: object): void {
  const msg = JSON.stringify(data);
  for (const ws of allSockets) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

function sendToUser(userId: string, data: object): void {
  const set = userSockets.get(userId);
  if (set) for (const ws of set) sendTo(ws, data);
}

// ─── Rate limiting with cleanup ───────────────────────────────────────────────

const rateLimits = new Map<string, number[]>();

// Cleanup stale entries every 60s to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of rateLimits) {
    if (!ts.some(t => now - t < 1000)) rateLimits.delete(id);
  }
}, 60_000);

function checkRateLimit(userId: string): boolean {
  const now    = Date.now();
  const recent = (rateLimits.get(userId) ?? []).filter(t => now - t < 1000);
  if (recent.length >= 10) return false;
  recent.push(now);
  rateLimits.set(userId, recent);
  return true;
}

// ─── Token ───────────────────────────────────────────────────────────────────

function extractToken(req: IncomingMessage): string | null {
  try { return new URL(req.url ?? '', 'http://x').searchParams.get('token'); }
  catch { return null; }
}

// ─── Game event bridge ────────────────────────────────────────────────────────

export function attachGameEvents(tables: Map<number, TableLoop>): void {
  for (const [, table] of tables) {
    table.on('round_start',    (d) => broadcast({ type: 'ROUND_START',    ...d }));
    table.on('betting_closed', (d) => broadcast({ type: 'BETTING_CLOSED', ...d }));
    table.on('tick',           (d) => broadcast({ type: 'TICK',           ...d }));
    table.on('crash',          (d) => broadcast({ type: 'CRASH',          ...d }));
    table.on('cooldown',       (d) => broadcast({ type: 'COOLDOWN',       ...d }));

    // bet_placed: public bet feed + personal balance update
    table.on('bet_placed', ({ newBalance, newCredit, userId, ...pub }) => {
      broadcast({ type: 'BET_PLACED', ...pub });
      sendToUser(userId as string, { type: 'BALANCE_UPDATE', balance: newBalance, credit: newCredit });
    });

    // cashout: public cashout event + personal balance update
    table.on('cashout', ({ newBalance, newCredit, userId, ...pub }) => {
      broadcast({ type: 'CASHOUT_EVENT', ...pub });
      sendToUser(userId as string, { type: 'BALANCE_UPDATE', balance: newBalance, credit: newCredit });
    });
  }
  logger.info(`WS game events attached for ${tables.size} table(s)`);
}

// ─── WS server ────────────────────────────────────────────────────────────────

export function createWsServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Heartbeat — prune zombie connections
  const heartbeat = setInterval(() => {
    for (const ws of allSockets) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', async (rawWs: WebSocket, req: IncomingMessage) => {
    const token = extractToken(req);
    if (!token) { rawWs.close(4001, 'Missing token'); return; }

    let payload: { sub: string; username: string };
    try {
      payload = jwt.verify(token, env.JWT_SECRET) as { sub: string; username: string };
    } catch {
      rawWs.close(4001, 'Invalid or expired token');
      return;
    }

    let accountType: string;
    try {
      const { rows } = await pool.query(
        'SELECT is_banned, account_type FROM users WHERE id = $1', [payload.sub]
      );
      if (!rows[0])          { rawWs.close(4001, 'User not found');    return; }
      if (rows[0].is_banned) { rawWs.close(4003, 'Account suspended'); return; }
      accountType = rows[0].account_type as string;
    } catch {
      rawWs.close(4500, 'Server error'); return;
    }

    const ws         = rawWs as AuthedWs;
    ws.userId        = payload.sub;
    ws.username      = payload.username;
    ws.accountType   = accountType;
    ws.isAlive       = true;

    // IP connection limit — prevents one IP opening hundreds of WS connections
    const clientIp = req.socket.remoteAddress ?? 'unknown';
    const ipCount  = ipConnections.get(clientIp) ?? 0;
    if (ipCount >= MAX_CONN_PER_IP) {
      ws.close(4029, 'Too many connections from this IP');
      return;
    }
    ipConnections.set(clientIp, ipCount + 1);

    ws.on('pong', () => { ws.isAlive = true; });
    registerSocket(ws);

    logger.info('WS connected', { userId: ws.userId, username: ws.username });

    // Send full initial state — everything the UI needs to render immediately
    const [{ rows: wallet }, { rows: history }] = await Promise.all([
      pool.query('SELECT balance, credit FROM users WHERE id = $1', [ws.userId]),
      pool.query(
        `SELECT table_id, crash_point, seed_hash, crashed_at
         FROM game_rounds WHERE status = 'crashed'
         ORDER BY crashed_at DESC LIMIT 50`
      ),
    ]);

    sendTo(ws, {
      type:       'CONNECTED',
      tables:     gameManager.getAllStates(),
      liveBets:   gameManager.getAllBetFeeds(), // current round bets for All Bets panel
      history,                                  // crash history for graph
    });

    if (wallet[0]) {
      sendTo(ws, { type: 'BALANCE_UPDATE', balance: wallet[0].balance, credit: wallet[0].credit });
    }

    ws.on('message', async (raw: RawData) => {
      if (!checkRateLimit(ws.userId)) {
        sendTo(ws, { type: 'ERROR', code: 'RATE_LIMIT', message: 'Too many messages', reconnectAfter: 1000 });
        return;
      }
      if (raw.toString().length > 512) {
        sendTo(ws, { type: 'ERROR', code: 'MSG_TOO_LARGE', message: 'Message too large' });
        return;
      }

      let msg: ClientMsg;
      try { msg = JSON.parse(raw.toString()); }
      catch {
        sendTo(ws, { type: 'ERROR', code: 'INVALID_JSON', message: 'Invalid JSON' });
        return;
      }

      try {
        await handleClientMessage(ws, msg);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Action failed';
        sendTo(ws, { type: 'ERROR', code: 'ACTION_FAILED', message });
      }
    });

    ws.on('close', (code, reason) => {
      logger.info('WS disconnected', { userId: ws.userId, code, reason: reason.toString() });
      unregisterSocket(ws);
      // Decrement IP connection count
      const cnt = ipConnections.get(clientIp) ?? 1;
      if (cnt <= 1) ipConnections.delete(clientIp);
      else ipConnections.set(clientIp, cnt - 1);
    });

    ws.on('error', (err) => {
      logger.error('WS socket error', { userId: ws.userId, error: err.message });
      unregisterSocket(ws);
    });
  });

  return wss;
}

// ─── Message handler ──────────────────────────────────────────────────────────

async function handleClientMessage(ws: AuthedWs, msg: ClientMsg): Promise<void> {
  switch (msg.type) {
    case 'PING':
      sendTo(ws, { type: 'PONG', ts: Date.now() });
      break;

    case 'BET': {
      const tableId      = Number(msg.tableId);
      const amount       = Number(msg.amount);
      const currencyType = msg.currencyType as string;
      const panel        = (Number(msg.panel ?? 0)) as 0 | 1;
      const autoCashoutAt = msg.autoCashoutAt != null ? Number(msg.autoCashoutAt) : null;

      if (!tableId || !amount)                                       throw new Error('tableId and amount required');
      if (currencyType !== 'balance' && currencyType !== 'credit')   throw new Error('currencyType must be balance or credit');
      if (panel !== 0 && panel !== 1)                                 throw new Error('panel must be 0 or 1');

      const table = gameManager.getTable(tableId);
      if (!table) throw new Error('Table not found');

      const result = await table.placeBet(
        ws.userId, ws.username, amount, currencyType, panel,
        ws.accountType === 'demo', autoCashoutAt
      );
      sendTo(ws, { type: 'BET_CONFIRMED', betId: result.betId, panel: result.panel, tableId, amount, autoCashoutAt });
      break;
    }

    case 'CASHOUT': {
      const tableId = Number(msg.tableId);
      const betId   = typeof msg.betId === 'string' ? msg.betId : null;
      if (!tableId) throw new Error('tableId required');

      const table = gameManager.getTable(tableId);
      if (!table) throw new Error('Table not found');

      if (betId) {
        const result = await table.cashout(ws.userId, betId);
        sendTo(ws, { type: 'CASHOUT_CONFIRMED', tableId, betId, panel: result.panel, multiplier: result.multiplier, payout: result.payout });
      } else {
        const results = await table.cashoutAll(ws.userId);
        for (const r of results) {
          sendTo(ws, { type: 'CASHOUT_CONFIRMED', tableId, panel: r.panel, multiplier: r.multiplier, payout: r.payout });
        }
      }
      break;
    }

    default:
      sendTo(ws, { type: 'ERROR', code: 'UNKNOWN_TYPE', message: `Unknown type: ${String(msg.type)}`, reconnectAfter: null });
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export function getOnlineUserCount(): number { return userSockets.size; }
