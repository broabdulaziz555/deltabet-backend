import { EventEmitter } from 'events';
import { pool, withTransaction } from '../db/pool';
import { writeLedger } from '../modules/wallet/wallet.service';
import {
  generateCrashPoint, generateDemoTableCrash,
  getDemoCashoutTarget, computeMultiplier,
  generateSeed, hashSeed,
} from '../utils/crash';
import { GAME, CURRENCY, Currency } from '../config/constants';
import { logger } from '../utils/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActiveBet {
  betId:             string;
  userId:            string;
  username:          string;
  amount:            number;
  currencyType:      Currency;
  panel:             0 | 1;
  isDemo:            boolean;
  demoCashoutTarget: number | null; // server-side demo bias (hidden)
  autoCashoutAt:     number | null; // user-set auto cashout target (visible)
  roundId:           string;
}

export interface TablePublicState {
  tableId:           number;
  status:            string;
  roundId:           string | null;
  seedHash:          string;
  currentMultiplier: number;
  bettingEndsAt:     number | null;
  activeBetsCount:   number;
}

// Public shape of an active bet (for live bet feed — no internal fields)
export interface PublicBet {
  betId:         string;
  userId:        string;
  username:      string;
  amount:        number;
  currencyType:  Currency;
  panel:         0 | 1;
  autoCashoutAt: number | null;
  status:        'active' | 'won' | 'lost';
  cashoutAt?:    number;
  payout?:       number;
}

interface TableState {
  tableId:           number;
  status:            'waiting' | 'betting' | 'flying' | 'crashed';
  roundId:           string | null;
  seed:              string;
  seedHash:          string;
  crashPoint:        number;
  currentMultiplier: number;
  flyingStartedAt:   number | null;
  bettingEndsAt:     number | null;
  activeBets:        Map<string, ActiveBet>; // key = `${userId}_${panel}`
  tickInterval:      NodeJS.Timeout | null;
  bettingTimer:      NodeJS.Timeout | null;
}

function betKey(userId: string, panel: 0 | 1) { return `${userId}_${panel}`; }

// ─── TableLoop ────────────────────────────────────────────────────────────────

export class TableLoop extends EventEmitter {
  private state:        TableState;
  private stopping    = false;
  private crashLock   = false;
  private pendingBets = new Set<string>();

  private readonly bettingPhaseMs: number;
  private readonly tickMs:         number;

  constructor(tableId: number, bettingPhaseMs = GAME.BETTING_PHASE_MS, tickMs = GAME.TICK_MS) {
    super();
    this.bettingPhaseMs = bettingPhaseMs;
    this.tickMs         = tickMs;
    this.state = {
      tableId,
      status:            'waiting',
      roundId:           null,
      seed:              '',
      seedHash:          '',
      crashPoint:        0,
      currentMultiplier: 1.00,
      flyingStartedAt:   null,
      bettingEndsAt:     null,
      activeBets:        new Map(),
      tickInterval:      null,
      bettingTimer:      null,
    };
  }

  getPublicState(): TablePublicState {
    return {
      tableId:           this.state.tableId,
      status:            this.state.status,
      roundId:           this.state.roundId,
      seedHash:          this.state.seedHash,
      currentMultiplier: this.state.currentMultiplier,
      bettingEndsAt:     this.state.bettingEndsAt,
      activeBetsCount:   this.state.activeBets.size,
    };
  }

  /** Public list of active bets for live feed (strips internal fields) */
  getActiveBetsFeed(): PublicBet[] {
    return Array.from(this.state.activeBets.values()).map(b => ({
      betId:         b.betId,
      userId:        b.userId,
      username:      b.username,
      amount:        b.amount,
      currencyType:  b.currencyType,
      panel:         b.panel,
      autoCashoutAt: b.autoCashoutAt,
      status:        'active' as const,
    }));
  }

  async start() { this.stopping = false; await this.startBetting(); }
  stop()        { this.stopping = true;  this.clearTimers(); }

  private clearTimers() {
    if (this.state.tickInterval) { clearInterval(this.state.tickInterval); this.state.tickInterval = null; }
    if (this.state.bettingTimer) { clearTimeout(this.state.bettingTimer);  this.state.bettingTimer  = null; }
  }

  // ── State machine ──────────────────────────────────────────────────────────

  private async startBetting() {
    if (this.stopping) return;

    const seed       = generateSeed();
    const seedHash   = hashSeed(seed);
    const crashPoint = this.areAllBetsDemo()
      ? generateDemoTableCrash(seed)
      : generateCrashPoint(seed, GAME.HOUSE_EDGE_REAL);

    const { rows } = await pool.query(
      `INSERT INTO game_rounds (table_id, crash_point, seed, seed_hash, started_at, status)
       VALUES ($1, $2, $3, $4, now(), 'active') RETURNING id`,
      [this.state.tableId, crashPoint, seed, seedHash]
    );
    const roundId       = rows[0].id as string;
    const bettingEndsAt = Date.now() + this.bettingPhaseMs;

    this.state.status            = 'betting';
    this.state.roundId           = roundId;
    this.state.seed              = seed;
    this.state.seedHash          = seedHash;
    this.state.crashPoint        = crashPoint;
    this.state.currentMultiplier = 1.00;
    this.state.flyingStartedAt   = null;
    this.state.bettingEndsAt     = bettingEndsAt;
    this.state.activeBets        = new Map();
    this.crashLock               = false;

    await pool.query(`UPDATE game_tables SET status = 'betting' WHERE id = $1`, [this.state.tableId]);
    this.emit('round_start', { tableId: this.state.tableId, roundId, seedHash, bettingEndsAt });
    this.state.bettingTimer = setTimeout(() => this.startFlying(), this.bettingPhaseMs);
    logger.info('Round started', { tableId: this.state.tableId, roundId });
  }

  private startFlying() {
    if (this.stopping) return;
    this.state.status            = 'flying';
    this.state.flyingStartedAt   = Date.now();
    this.state.currentMultiplier = 1.00;
    pool.query(`UPDATE game_tables SET status = 'flying' WHERE id = $1`, [this.state.tableId])
      .catch(err => logger.error('DB flying update failed', { error: (err as Error).message }));
    this.emit('betting_closed', { tableId: this.state.tableId });
    this.state.tickInterval = setInterval(() => this.tick(), this.tickMs);
  }

  private tick() {
    if (this.state.status !== 'flying' || !this.state.flyingStartedAt) return;
    if (this.crashLock) return;

    const elapsed    = Date.now() - this.state.flyingStartedAt;
    const multiplier = computeMultiplier(elapsed);
    this.state.currentMultiplier = multiplier;

    if (multiplier >= this.state.crashPoint) {
      this.crashLock = true;
      this.crash().catch(err => logger.error('Crash error', { error: (err as Error).message }));
      return;
    }

    // Check auto-cashout targets (both user-set and demo)
    for (const [key, bet] of this.state.activeBets) {
      // User-set auto cashout
      if (bet.autoCashoutAt !== null && multiplier >= bet.autoCashoutAt) {
        this.processCashout(key).catch(err =>
          logger.error('Auto-cashout failed', { key, error: (err as Error).message })
        );
        continue;
      }
      // Demo server-side bias cashout
      if (bet.isDemo && bet.demoCashoutTarget !== null && multiplier >= bet.demoCashoutTarget) {
        this.processCashout(key).catch(err =>
          logger.error('Demo cashout failed', { key, error: (err as Error).message })
        );
      }
    }

    this.emit('tick', { tableId: this.state.tableId, multiplier, elapsed });
  }

  private async crash() {
    this.clearTimers();
    const { crashPoint, seed, roundId, tableId } = {
      crashPoint: this.state.crashPoint,
      seed:       this.state.seed,
      roundId:    this.state.roundId!,
      tableId:    this.state.tableId,
    };
    this.state.status = 'crashed';
    this.state.activeBets.clear();

    await pool.query(`UPDATE bets SET status = 'lost' WHERE round_id = $1 AND status = 'active'`, [roundId]);
    await pool.query(`UPDATE game_rounds SET status = 'crashed', crashed_at = now() WHERE id = $1`, [roundId]);
    await pool.query(`UPDATE game_tables SET status = 'crashed' WHERE id = $1`, [tableId]);

    logger.info('Round crashed', { tableId, roundId, crashPoint });
    this.emit('crash', { tableId, crashPoint, seed, roundId });

    // Tell clients exactly when the next betting phase starts
    const nextBettingAt = Date.now() + GAME.CRASH_COOLDOWN_MS;
    this.emit('cooldown', { tableId, nextBettingAt, cooldownMs: GAME.CRASH_COOLDOWN_MS });

    if (!this.stopping) {
      setTimeout(
        () => this.startBetting().catch(err => logger.error('startBetting error', { error: (err as Error).message })),
        GAME.CRASH_COOLDOWN_MS
      );
    }
  }

  // ── Bet ────────────────────────────────────────────────────────────────────

  async placeBet(
    userId:        string,
    username:      string,
    amount:        number,
    currencyType:  Currency,
    panel:         0 | 1,
    isDemo:        boolean,
    autoCashoutAt: number | null = null
  ): Promise<{ betId: string; panel: 0 | 1; newBalance: number; newCredit: number }> {

    const key = betKey(userId, panel);

    if (this.state.status !== 'betting')                            throw new Error('Not in betting phase');
    if (this.state.activeBets.has(key) || this.pendingBets.has(key)) throw new Error(`Panel ${panel + 1} already has an active bet`);
    if (amount < GAME.MIN_BET)  throw new Error(`Minimum bet is ${GAME.MIN_BET.toLocaleString()} soums`);
    if (amount > GAME.MAX_BET)  throw new Error(`Maximum bet is ${GAME.MAX_BET.toLocaleString()} soums`);
    if (autoCashoutAt !== null && autoCashoutAt < 1.01) throw new Error('Auto cashout must be at least 1.01x');

    this.pendingBets.add(key);
    const roundId = this.state.roundId!;
    const tableId = this.state.tableId;

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query(
          'SELECT balance, credit FROM users WHERE id = $1 FOR UPDATE', [userId]
        );
        if (!rows[0]) throw new Error('User not found');

        const balance = parseFloat(rows[0].balance);
        const credit  = parseFloat(rows[0].credit);
        let newBalance = balance;
        let newCredit  = credit;

        // Combined wallet: deduct from balance first, overflow into credit
        if (balance + credit < amount) throw new Error('Insufficient funds');

        if (balance >= amount) {
          // Enough in balance — use only balance
          await client.query(
            'UPDATE users SET balance = balance - $1, updated_at = now() WHERE id = $2', [amount, userId]
          );
          newBalance = balance - amount;
          await writeLedger(client, userId, 'bet', CURRENCY.BALANCE, -amount, newBalance);
        } else {
          // Use all balance, remainder from credit
          const fromCredit = amount - balance;
          await client.query(
            'UPDATE users SET balance = 0, credit = credit - $1, updated_at = now() WHERE id = $2',
            [fromCredit, userId]
          );
          newBalance = 0;
          newCredit  = credit - fromCredit;
          if (balance > 0) {
            await writeLedger(client, userId, 'bet', CURRENCY.BALANCE, -balance, 0);
          }
          await writeLedger(client, userId, 'bet', CURRENCY.CREDIT, -fromCredit, newCredit);
        }

        const { rows: br } = await client.query(
          `INSERT INTO bets (user_id, round_id, table_id, amount, currency_type)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [userId, roundId, tableId, amount, currencyType]
        );
        return { betId: br[0].id as string, newBalance, newCredit };
      });

      const demoCashoutTarget = isDemo ? getDemoCashoutTarget() : null;
      const bet: ActiveBet = {
        betId: result.betId, userId, username, amount, currencyType,
        panel, isDemo, demoCashoutTarget, autoCashoutAt, roundId,
      };
      this.state.activeBets.set(key, bet);

      this.emit('bet_placed', {
        tableId, userId, username, amount, panel, currencyType,
        autoCashoutAt,
        betId:      result.betId,   // needed by public bet feed
        newBalance: result.newBalance,
        newCredit:  result.newCredit,
      });

      return { betId: result.betId, panel, newBalance: result.newBalance, newCredit: result.newCredit };
    } finally {
      this.pendingBets.delete(key);
    }
  }

  // ── Cashout ────────────────────────────────────────────────────────────────

  async cashout(userId: string, betId: string): Promise<{ multiplier: number; payout: number; panel: 0 | 1 }> {
    if (this.state.status !== 'flying') throw new Error('Game is not in flying phase');
    let foundKey: string | null = null;
    for (const [k, b] of this.state.activeBets) {
      if (b.userId === userId && b.betId === betId) { foundKey = k; break; }
    }
    if (!foundKey) throw new Error('No active bet found with that ID');
    return this.processCashout(foundKey);
  }

  async cashoutAll(userId: string): Promise<Array<{ multiplier: number; payout: number; panel: 0 | 1 }>> {
    if (this.state.status !== 'flying') throw new Error('Game is not in flying phase');
    const keys = Array.from(this.state.activeBets.keys()).filter(k => this.state.activeBets.get(k)!.userId === userId);
    if (!keys.length) throw new Error('No active bets on this table');
    return Promise.all(keys.map(k => this.processCashout(k)));
  }

  private async processCashout(key: string): Promise<{ multiplier: number; payout: number; panel: 0 | 1 }> {
    const bet = this.state.activeBets.get(key);
    if (!bet) throw new Error('No active bet');
    this.state.activeBets.delete(key); // sync — double-cashout guard

    const multiplier = this.state.currentMultiplier;
    const payout     = Math.floor(bet.amount * multiplier * 100) / 100;

    const { newBalance, newCredit } = await withTransaction(async (client) => {
      const { rows } = await client.query(
        'UPDATE users SET balance = balance + $1, updated_at = now() WHERE id = $2 RETURNING balance',
        [payout, bet.userId]
      );
      const bal = parseFloat(rows[0].balance);
      await client.query(
        `UPDATE bets SET status = 'won', cashout_at = $1, payout = $2 WHERE id = $3`,
        [multiplier, payout, bet.betId]
      );
      await writeLedger(
        client, bet.userId, 'win', CURRENCY.BALANCE, payout, bal,
        bet.betId, `Cashout at ${multiplier}x (panel ${bet.panel + 1})`
      );
      const { rows: w } = await client.query('SELECT credit FROM users WHERE id = $1', [bet.userId]);
      return { newBalance: bal, newCredit: parseFloat(w[0].credit) };
    });

    this.emit('cashout', {
      tableId: this.state.tableId, userId: bet.userId, username: bet.username,
      multiplier, payout, amount: bet.amount, panel: bet.panel, betId: bet.betId,
      newBalance, newCredit,
    });

    logger.info('Cashout', { userId: bet.userId, multiplier, payout, panel: bet.panel });
    return { multiplier, payout, panel: bet.panel };
  }

  private areAllBetsDemo(): boolean {
    if (!this.state.activeBets.size) return false;
    for (const b of this.state.activeBets.values()) if (!b.isDemo) return false;
    return true;
  }
}

// ─── GameManager ──────────────────────────────────────────────────────────────

export class GameManager {
  readonly tables: Map<number, TableLoop> = new Map();

  async init(tableCount: number, bettingPhaseMs = GAME.BETTING_PHASE_MS, tickMs = GAME.TICK_MS) {
    // Ensure the right number of tables exist in DB
    const { rows: existing } = await pool.query('SELECT id FROM game_tables ORDER BY id');
    for (let i = existing.length + 1; i <= tableCount; i++) {
      await pool.query(
        `INSERT INTO game_tables (name, status) VALUES ($1, 'waiting') ON CONFLICT DO NOTHING`,
        [`Table ${i}`]
      );
      logger.info(`Created game table ${i}`);
    }

    const { rows } = await pool.query('SELECT id FROM game_tables ORDER BY id LIMIT $1', [tableCount]);
    if (!rows.length) throw new Error('No game tables found after init');

    for (const row of rows) {
      const loop = new TableLoop(row.id, bettingPhaseMs, tickMs);
      this.tables.set(row.id, loop);
      await loop.start();
      logger.info('Game loop started', { tableId: row.id });
    }
  }

  getTable(tableId: number)   { return this.tables.get(tableId); }
  getAllStates()               { return Array.from(this.tables.values()).map(t => t.getPublicState()); }
  getAllBetFeeds()             { return Array.from(this.tables.values()).map(t => ({ tableId: t.getPublicState().tableId, bets: t.getActiveBetsFeed() })); }
  stop()                      { for (const l of this.tables.values()) l.stop(); }
}

export const gameManager = new GameManager();
