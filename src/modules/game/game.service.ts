import { pool }                                from '../../db/pool';
import { gameManager }                         from '../../ws/gameLoop';
import { AppError, paginate, paginatedResponse } from '../../utils/helpers';
import { Currency }                            from '../../config/constants';
import { t, Lang }                             from '../i18n/translations';
import { hashSeed }                            from '../../utils/crash';

export async function getTables() {
  const { rows } = await pool.query('SELECT id, name, status FROM game_tables ORDER BY id');
  const states   = gameManager.getAllStates();
  return rows.map(row => {
    const s = states.find(st => st.tableId === row.id);
    return {
      id:                row.id,
      name:              row.name,
      status:            s?.status            ?? row.status,
      roundId:           s?.roundId           ?? null,
      seedHash:          s?.seedHash          ?? null,
      currentMultiplier: s?.currentMultiplier ?? 1.00,
      bettingEndsAt:     s?.bettingEndsAt     ?? null,
      activeBetsCount:   s?.activeBetsCount   ?? 0,
    };
  });
}

export async function getTableHistory(tableId: number, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, crash_point, started_at, crashed_at, seed_hash
     FROM game_rounds WHERE table_id = $1 AND status = 'crashed'
     ORDER BY crashed_at DESC LIMIT $2`,
    [tableId, Math.min(limit, 200)]
  );
  return rows;
}

export async function getTableLiveBets(tableId: number) {
  const table = gameManager.getTable(tableId);
  if (!table) throw new AppError(404, 'Table not found');
  return {
    tableId,
    status: table.getPublicState().status,
    bets:   table.getActiveBetsFeed(),
  };
}

export async function getRound(roundId: string) {
  const { rows } = await pool.query(
    `SELECT id, table_id, crash_point, started_at, crashed_at, status, seed_hash,
       CASE WHEN status = 'crashed' THEN seed ELSE NULL END AS seed
     FROM game_rounds WHERE id = $1`,
    [roundId]
  );
  if (!rows[0]) throw new AppError(404, 'Round not found');
  return rows[0];
}

/** Provably fair verification endpoint */
export async function verifyRound(roundId: string) {
  const { rows } = await pool.query(
    `SELECT id, crash_point, seed, seed_hash, status
     FROM game_rounds WHERE id = $1 AND status = 'crashed'`,
    [roundId]
  );
  if (!rows[0]) throw new AppError(404, 'Round not found or not yet crashed');

  const round = rows[0];
  // Recompute hash from seed to verify integrity
  const computedHash = hashSeed(round.seed);
  const hashMatches  = computedHash === round.seed_hash;

  // Recompute crash point from seed
  const { generateCrashPoint } = await import('../../utils/crash');
  const computedCrash = generateCrashPoint(round.seed, 0.05);
  const crashMatches  = Math.abs(computedCrash - parseFloat(round.crash_point)) < 0.01;

  return {
    roundId:        round.id,
    crashPoint:     parseFloat(round.crash_point),
    seed:           round.seed,
    seedHash:       round.seed_hash,
    verified:       hashMatches && crashMatches,
    checks: {
      seedHashValid:   hashMatches,
      crashPointValid: crashMatches,
      computedCrash,
      computedHash,
    },
    howToVerify: [
      '1. SHA256(seed) must equal seedHash',
      '2. HMAC-SHA256(seed, "deltabet") → compute crash point formula',
      '3. h = parseInt(hash.slice(0,8), 16)',
      '4. if h % 33 === 0 → 1.00x',
      '5. else → (100 / 0.95) * (2^32 / (h+1)) / 100',
    ],
  };
}

export async function placeBetHttp(
  userId:        string,
  username:      string,
  tableId:       number,
  amount:        number,
  currencyType:  Currency,
  panel:         0 | 1,
  isDemo:        boolean,
  autoCashoutAt: number | null,
  lang:          Lang = 'ru'
) {
  const table = gameManager.getTable(tableId);
  if (!table) throw new AppError(404, 'Table not found');
  try {
    return await table.placeBet(userId, username, amount, currencyType, panel, isDemo, autoCashoutAt);
  } catch (err: unknown) {
    throw new AppError(400, err instanceof Error ? err.message : t('betPhaseOver', lang));
  }
}

export async function cashoutHttp(userId: string, tableId: number, betId?: string, lang: Lang = 'ru') {
  const table = gameManager.getTable(tableId);
  if (!table) throw new AppError(404, 'Table not found');
  try {
    if (betId) return await table.cashout(userId, betId);
    return await table.cashoutAll(userId);
  } catch (err: unknown) {
    throw new AppError(400, err instanceof Error ? err.message : t('notFlying', lang));
  }
}

export async function getMyBets(userId: string, page = 1, limit = 20) {
  const { limit: l, offset, page: p } = paginate(page, limit);
  const [{ rows }, { rows: cnt }] = await Promise.all([
    pool.query(
      `SELECT b.id, b.round_id, b.table_id, b.amount, b.currency_type,
              b.cashout_at, b.payout, b.status, b.placed_at,
              gr.crash_point, gt.name AS table_name
       FROM bets b
       JOIN game_rounds gr ON gr.id = b.round_id
       JOIN game_tables  gt ON gt.id = b.table_id
       WHERE b.user_id = $1
       ORDER BY b.placed_at DESC LIMIT $2 OFFSET $3`,
      [userId, l, offset]
    ),
    pool.query('SELECT COUNT(*)::int AS total FROM bets WHERE user_id = $1', [userId]),
  ]);
  return paginatedResponse(rows, cnt[0].total, p, l);
}

/** User's active bets across all tables — for reconnection state recovery */
export async function getMyActiveBets(userId: string) {
  const allFeeds = gameManager.getAllBetFeeds();
  const myBets: Array<{ tableId: number; betId: string; amount: number; currencyType: string; panel: 0 | 1; autoCashoutAt: number | null }> = [];

  for (const feed of allFeeds) {
    for (const bet of feed.bets) {
      if (bet.userId === userId) {
        myBets.push({
          tableId:      feed.tableId,
          betId:        bet.betId,
          amount:       bet.amount,
          currencyType: bet.currencyType,
          panel:        bet.panel,
          autoCashoutAt: bet.autoCashoutAt,
        });
      }
    }
  }
  return myBets;
}
