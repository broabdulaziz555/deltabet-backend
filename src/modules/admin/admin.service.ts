import { CURRENCY } from '../../config/constants';
import { pool, withTransaction } from '../../db/pool';
import { writeLedger } from '../wallet/wallet.service';
import { AppError, paginate, paginatedResponse } from '../../utils/helpers';
import { getOnlineUserCount } from '../../ws/wsServer';
import { gameManager } from '../../ws/gameLoop';

// Re-exports — single source of truth
export {
  adminGetDeposit,
  adminGetDeposits,
  adminApproveDeposit,
  adminRejectDeposit,
} from '../deposit/deposit.service';

export {
  adminGetWithdrawals,
  adminApproveWithdrawal,
  adminRejectWithdrawal,
} from '../withdrawal/withdrawal.service';

export {
  adminListPromos,
  adminGetPromo,
  adminCreatePromo,
  adminUpdatePromo,
  adminTogglePromo,
  adminDeletePromo,
  adminAddTier,
  adminUpdateTier,
  adminDeleteTier,
} from '../promo/promo.service';

// ── Users ──────────────────────────────────────────────────────────────────

export async function getUsers(search?: string, page = 1, limit = 20) {
  const { limit: l, offset, page: p } = paginate(page, limit);
  const params: unknown[] = [];
  const where = search
    ? (params.push(`%${search}%`), `WHERE username ILIKE $1 OR id::text = $1`)
    : '';

  const [{ rows }, { rows: cnt }] = await Promise.all([
    pool.query(
      `SELECT id, username, account_type, lang, balance, credit, is_banned, created_at
       FROM users ${where} ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, l, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM users ${where}`, params),
  ]);
  return paginatedResponse(rows, cnt[0].total, p, l);
}

export async function getUser(id: string) {
  const [{ rows: ur }, { rows: stats }] = await Promise.all([
    pool.query(
      `SELECT id, username, account_type, lang, balance, credit,
              is_banned, ban_reason, telegram_id, created_at
       FROM users WHERE id = $1`,
      [id]
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'won')::int  AS bets_won,
         COUNT(*) FILTER (WHERE status = 'lost')::int AS bets_lost,
         COALESCE(SUM(amount), 0)                     AS total_wagered,
         COALESCE(SUM(payout), 0)                     AS total_won
       FROM bets WHERE user_id = $1`,
      [id]
    ),
  ]);
  if (!ur[0]) throw new AppError(404, 'User not found');
  return { ...ur[0], stats: stats[0] };
}

export async function setAccountType(id: string, accountType: string, adminUsername: string) {
  const { rows } = await pool.query(
    'UPDATE users SET account_type = $1, updated_at = now() WHERE id = $2 RETURNING id',
    [accountType, id]
  );
  if (!rows[0]) throw new AppError(404, 'User not found');
  await pool.query(
    `INSERT INTO admin_logs (admin, action, target_user, details) VALUES ($1, 'set_account_type', $2, $3)`,
    [adminUsername, id, JSON.stringify({ accountType })]
  );
  return { success: true };
}

export async function banUser(id: string, reason: string, adminUsername: string) {
  const { rows } = await pool.query(
    'UPDATE users SET is_banned = true, ban_reason = $1, updated_at = now() WHERE id = $2 RETURNING id',
    [reason, id]
  );
  if (!rows[0]) throw new AppError(404, 'User not found');
  await pool.query(
    `INSERT INTO admin_logs (admin, action, target_user, details) VALUES ($1, 'ban_user', $2, $3)`,
    [adminUsername, id, JSON.stringify({ reason })]
  );
  return { success: true };
}

export async function unbanUser(id: string, adminUsername: string) {
  const { rows } = await pool.query(
    'UPDATE users SET is_banned = false, ban_reason = NULL, updated_at = now() WHERE id = $1 RETURNING id',
    [id]
  );
  if (!rows[0]) throw new AppError(404, 'User not found');
  await pool.query(
    `INSERT INTO admin_logs (admin, action, target_user, details) VALUES ($1, 'unban_user', $2, $3)`,
    [adminUsername, id, JSON.stringify({})]
  );
  return { success: true };
}

export async function adjustBalance(
  id: string,
  type: 'add' | 'deduct',
  amount: number,
  note: string,
  adminUsername: string
) {
  if (amount <= 0) throw new AppError(400, 'Amount must be positive');

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT balance, credit FROM users WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!rows[0]) throw new AppError(404, 'User not found');

    const current = parseFloat(rows[0].balance);
    if (type === 'deduct' && current < amount) {
      throw new AppError(400, `Insufficient balance (has ${current}, tried to deduct ${amount})`);
    }

    const delta = type === 'add' ? amount : -amount;
    const { rows: ur } = await client.query(
      `UPDATE users SET balance = balance + $1, updated_at = now() WHERE id = $2
       RETURNING balance`,
      [delta, id]
    );

    await writeLedger(
      client, id,
      type === 'add' ? 'admin_add' : 'admin_deduct',
      CURRENCY.BALANCE,
      delta,
      parseFloat(ur[0].balance),
      undefined, note
    );

    await client.query(
      `INSERT INTO admin_logs (admin, action, target_user, details) VALUES ($1, 'adjust_balance', $2, $3)`,
      [adminUsername, id, JSON.stringify({ type, amount, note })]
    );

    return { success: true, balance: parseFloat(ur[0].balance), credit: parseFloat(ur[0].credit) };
  });
}

export async function getUserLedger(id: string, page = 1, limit = 20) {
  const { limit: l, offset, page: p } = paginate(page, limit);
  const [{ rows }, { rows: cnt }] = await Promise.all([
    pool.query(
      `SELECT * FROM balance_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [id, l, offset]
    ),
    pool.query('SELECT COUNT(*)::int AS total FROM balance_ledger WHERE user_id = $1', [id]),
  ]);
  return paginatedResponse(rows, cnt[0].total, p, l);
}

export async function getUserBets(id: string, page = 1, limit = 20) {
  const { limit: l, offset, page: p } = paginate(page, limit);
  const [{ rows }, { rows: cnt }] = await Promise.all([
    pool.query(
      `SELECT b.*, gr.crash_point, gt.name AS table_name
       FROM bets b
       JOIN game_rounds gr ON gr.id = b.round_id
       JOIN game_tables gt ON gt.id = b.table_id
       WHERE b.user_id = $1 ORDER BY b.placed_at DESC LIMIT $2 OFFSET $3`,
      [id, l, offset]
    ),
    pool.query('SELECT COUNT(*)::int AS total FROM bets WHERE user_id = $1', [id]),
  ]);
  return paginatedResponse(rows, cnt[0].total, p, l);
}

// ── Stats ──────────────────────────────────────────────────────────────────

// 30-second in-memory cache for heavy overview query
let overviewCache: { data: unknown; ts: number } | null = null;
const OVERVIEW_CACHE_TTL = 30_000;

export async function getOverviewStats() {
  // Return cached result if fresh
  if (overviewCache && Date.now() - overviewCache.ts < OVERVIEW_CACHE_TTL) {
    return overviewCache.data;
  }

  const [users, deposits, withdrawals, bets, rounds] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS new_today,
        COUNT(*) FILTER (WHERE updated_at > now() - interval '24 hours')::int AS active_today
      FROM users
    `),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::int  AS pending,
        COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
        COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
        COALESCE(SUM(amount_actual) FILTER (WHERE status = 'approved'), 0) AS total_approved_amount
      FROM deposits
    `),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::int  AS pending,
        COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
        COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
        COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0) AS total_approved_amount
      FROM withdrawals
    `),
    pool.query(`
      SELECT
        COUNT(*)::int                              AS total_bets,
        COALESCE(SUM(amount), 0)                  AS total_wagered,
        COALESCE(SUM(payout), 0)                  AS total_payout
      FROM bets WHERE status != 'active'
    `),
    pool.query(`SELECT COUNT(*)::int AS total FROM game_rounds WHERE status = 'crashed'`),
  ]);

  const wagered = parseFloat(bets.rows[0].total_wagered);
  const payout  = parseFloat(bets.rows[0].total_payout);

  const result = {
    users: users.rows[0],
    deposits: deposits.rows[0],
    withdrawals: withdrawals.rows[0],
    bets: bets.rows[0],
    rounds: rounds.rows[0],
    houseProfit: wagered - payout,
    onlineUsers: getOnlineUserCount(),
    tables: gameManager.getAllStates(),
  };

  overviewCache = { data: result, ts: Date.now() };
  return result;
}

export async function getRevenue(from: string, to: string) {
  const { rows } = await pool.query(
    `SELECT
       DATE(placed_at)            AS date,
       COUNT(*)::int              AS bets,
       COALESCE(SUM(amount), 0)  AS wagered,
       COALESCE(SUM(payout), 0)  AS payout,
       COALESCE(SUM(amount) - SUM(payout), 0) AS profit
     FROM bets
     WHERE status != 'active' AND placed_at BETWEEN $1 AND $2
     GROUP BY DATE(placed_at)
     ORDER BY date ASC`,
    [from, to]
  );
  return rows;
}

export async function getTopUsers() {
  const [byBalance, byBets, byDeposits] = await Promise.all([
    pool.query(
      'SELECT id, username, balance FROM users ORDER BY balance DESC LIMIT 10'
    ),
    pool.query(
      `SELECT user_id, COUNT(*)::int AS bet_count, COALESCE(SUM(amount), 0) AS total_wagered
       FROM bets GROUP BY user_id ORDER BY bet_count DESC LIMIT 10`
    ),
    pool.query(
      `SELECT user_id, COALESCE(SUM(amount_actual), 0) AS total_deposited
       FROM deposits WHERE status = 'approved'
       GROUP BY user_id ORDER BY total_deposited DESC LIMIT 10`
    ),
  ]);
  return { byBalance: byBalance.rows, byBets: byBets.rows, byDeposits: byDeposits.rows };
}

export async function getRounds(tableId?: number, from?: string, to?: string, page = 1, limit = 50) {
  const { limit: l, offset, page: p } = paginate(page, limit);
  const conditions = ["status = 'crashed'"];
  const params: unknown[] = [];
  if (tableId) { params.push(tableId); conditions.push(`table_id = $${params.length}`); }
  if (from)    { params.push(from);    conditions.push(`started_at >= $${params.length}`); }
  if (to)      { params.push(to);      conditions.push(`crashed_at <= $${params.length}`); }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const [{ rows }, { rows: cnt }] = await Promise.all([
    pool.query(
      `SELECT id, table_id, crash_point, seed_hash, started_at, crashed_at
       FROM game_rounds ${where}
       ORDER BY crashed_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, l, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM game_rounds ${where}`, params),
  ]);
  return paginatedResponse(rows, cnt[0].total, p, l);
}

export async function getAdminLogs(page = 1, limit = 50) {
  const { limit: l, offset, page: p } = paginate(page, limit);
  const [{ rows }, { rows: cnt }] = await Promise.all([
    pool.query(
      `SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [l, offset]
    ),
    pool.query('SELECT COUNT(*)::int AS total FROM admin_logs'),
  ]);
  return paginatedResponse(rows, cnt[0].total, p, l);
}

// ── Game control ───────────────────────────────────────────────────────────

export async function pauseTable(tableId: number) {
  const table = gameManager.getTable(tableId);
  if (!table) throw new AppError(404, 'Table not found');
  table.stop();
  await pool.query(`UPDATE game_tables SET status = 'waiting' WHERE id = $1`, [tableId]);
  return { success: true, message: 'Table paused' };
}

export async function resumeTable(tableId: number) {
  const table = gameManager.getTable(tableId);
  if (!table) throw new AppError(404, 'Table not found');
  await table.start();
  return { success: true, message: 'Table resumed' };
}
