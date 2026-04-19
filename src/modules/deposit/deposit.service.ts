import { pool, withTransaction } from '../../db/pool';
import { LIMITS, PAYMENT_METHODS, CURRENCY } from '../../config/constants';
import { AppError, paginate, paginatedResponse } from '../../utils/helpers';
import { writeLedger } from '../wallet/wallet.service';
import { t, Lang }    from '../i18n/translations';
import { PoolClient } from 'pg';
import { sendTelegramMessage, msgDepositApproved, msgDepositRejected } from '../../utils/telegram';


export async function createDeposit(
  userId:        string,
  amount:        number,
  paymentMethod: string,
  chequeRef:     string,
  promoCode?:    string,
  lang:          Lang = 'ru'
) {
  if (amount < LIMITS.MIN_DEPOSIT)                                   throw new AppError(400, t('minDeposit', lang));
  if (amount > LIMITS.MAX_TRANSACTION)                               throw new AppError(400, 'Amount exceeds max limit');
  if (!(PAYMENT_METHODS as readonly string[]).includes(paymentMethod)) throw new AppError(400, 'Invalid payment method');

  const { rows } = await pool.query(
    `INSERT INTO deposits (user_id, amount_claimed, payment_method, cheque_ref, promo_code)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, amount, paymentMethod, chequeRef, promoCode ?? null]
  );
  return rows[0];
}

export async function getUserDeposits(userId: string, page = 1, limit = 20) {
  const { limit: l, offset, page: p } = paginate(page, limit);
  const [{ rows }, { rows: cnt }] = await Promise.all([
    pool.query(
      `SELECT id, amount_claimed, amount_actual, payment_method, cheque_ref,
              promo_code, status, admin_note, created_at, processed_at
       FROM deposits WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, l, offset]
    ),
    pool.query('SELECT COUNT(*)::int AS total FROM deposits WHERE user_id = $1', [userId]),
  ]);
  return paginatedResponse(rows, cnt[0].total, p, l);
}

export async function adminGetDeposit(depositId: string) {
  const { rows } = await pool.query(
    `SELECT d.*, u.username FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.id = $1`,
    [depositId]
  );
  if (!rows[0]) throw new AppError(404, 'Deposit not found');
  return rows[0];
}

export async function adminGetDeposits(
  page = 1, limit = 20,
  status?:    string,
  userId?:    string,
  chequeRef?: string,   // partial match on cheque reference
  from?:      string,   // ISO date filter
  to?:        string
) {
  const { limit: l, offset, page: p } = paginate(page, limit);
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (status)    { params.push(status);             conditions.push(`d.status = $${params.length}`); }
  if (userId)    { params.push(userId);             conditions.push(`d.user_id = $${params.length}`); }
  if (chequeRef) { params.push(`%${chequeRef}%`);  conditions.push(`d.cheque_ref ILIKE $${params.length}`); }
  if (from)      { params.push(from);              conditions.push(`d.created_at >= $${params.length}`); }
  if (to)        { params.push(to);                conditions.push(`d.created_at <= $${params.length}`); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const [{ rows }, { rows: cnt }] = await Promise.all([
    pool.query(
      `SELECT d.*, u.username FROM deposits d JOIN users u ON u.id = d.user_id
       ${where} ORDER BY d.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, l, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM deposits d ${where}`, params),
  ]);
  return paginatedResponse(rows, cnt[0].total, p, l);
}

export async function adminApproveDeposit(depositId: string, amountActual: number, adminUsername: string) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM deposits WHERE id = $1 FOR UPDATE', [depositId]
    );
    const dep = rows[0];
    if (!dep) throw new AppError(404, 'Deposit not found');
    if (dep.status !== 'pending') throw new AppError(400, 'Deposit already processed');

    // Credit real balance (deposit goes to balance, not credit)
    const { rows: ur } = await client.query(
      'UPDATE users SET balance = balance + $1, updated_at = now() WHERE id = $2 RETURNING balance',
      [amountActual, dep.user_id]
    );
    const newBalance = parseFloat(ur[0].balance);
    await writeLedger(client, dep.user_id, 'deposit', CURRENCY.BALANCE, amountActual, newBalance, depositId);

    await client.query(
      `UPDATE deposits SET status = 'approved', amount_actual = $1,
       processed_at = now(), processed_by = $2 WHERE id = $3`,
      [amountActual, adminUsername, depositId]
    );

    // Apply promo bonus → credited to credit (bonus UZS, non-withdrawable)
    let bonusGiven = 0;
    if (dep.promo_code) {
      bonusGiven = await applyPromoBonus(client, dep.user_id, dep.promo_code, amountActual, depositId);
    }

    await client.query(
      `INSERT INTO admin_logs (admin, action, target_user, details)
       VALUES ($1, 'approve_deposit', $2, $3)`,
      [adminUsername, dep.user_id, JSON.stringify({ depositId, amountActual, bonusGiven })]
    );

    // Notify user via Telegram (fire-and-forget, never blocks)
    const { rows: tgRows } = await client.query(
      'SELECT telegram_id FROM users WHERE id = $1', [dep.user_id]
    );
    sendTelegramMessage(
      tgRows[0]?.telegram_id,
      msgDepositApproved(amountActual, bonusGiven)
    ).catch(() => {});

    return { approved: true, amountActual, bonusGiven };
  });
}

export async function adminRejectDeposit(depositId: string, note: string, adminUsername: string) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM deposits WHERE id = $1 FOR UPDATE', [depositId]
    );
    if (!rows[0]) throw new AppError(404, 'Deposit not found');
    if (rows[0].status !== 'pending') throw new AppError(400, 'Deposit already processed');

    await client.query(
      `UPDATE deposits SET status = 'rejected', admin_note = $1,
       processed_at = now(), processed_by = $2 WHERE id = $3`,
      [note, adminUsername, depositId]
    );
    await client.query(
      `INSERT INTO admin_logs (admin, action, target_user, details)
       VALUES ($1, 'reject_deposit', $2, $3)`,
      [adminUsername, rows[0].user_id, JSON.stringify({ depositId, note })]
    );
    // Notify user via Telegram
    const { rows: tgRows } = await client.query(
      'SELECT telegram_id FROM users WHERE id = $1', [rows[0].user_id]
    );
    sendTelegramMessage(
      tgRows[0]?.telegram_id,
      msgDepositRejected(rows[0].amount_claimed, note)
    ).catch(() => {});

    return { rejected: true };
  });
}

/**
 * Apply promo bonus to credit balance (bonus UZS — non-withdrawable).
 */
async function applyPromoBonus(
  client:        PoolClient,
  userId:        string,
  code:          string,
  depositAmount: number,
  depositId:     string
): Promise<number> {
  const { rows: pr } = await client.query(
    `SELECT * FROM promo_codes
     WHERE UPPER(code) = UPPER($1) AND is_active = true
     AND (expires_at IS NULL OR expires_at > now())
     AND (max_uses IS NULL OR used_count < max_uses)`,
    [code.toUpperCase()]
  );
  if (!pr[0]) return 0;

  const { rows: used } = await client.query(
    'SELECT id FROM promo_uses WHERE promo_id = $1 AND user_id = $2',
    [pr[0].id, userId]
  );
  if (used.length > 0) return 0;

  const { rows: tiers } = await client.query(
    `SELECT * FROM promo_tiers
     WHERE promo_id = $1 AND min_deposit <= $2
     ORDER BY min_deposit DESC LIMIT 1`,
    [pr[0].id, depositAmount]
  );
  if (!tiers[0]) return 0;

  // Calculate bonus amount
  const bonus = tiers[0].bonus_type === 'percent'
    ? Math.floor(depositAmount * (parseFloat(tiers[0].bonus_value) / 100))
    : parseFloat(tiers[0].bonus_value);
  if (bonus <= 0) return 0;

  // Add bonus to credit (non-withdrawable bonus UZS)
  const { rows: ur } = await client.query(
    'UPDATE users SET credit = credit + $1, updated_at = now() WHERE id = $2 RETURNING credit',
    [bonus, userId]
  );
  await writeLedger(
    client, userId, 'deposit_bonus', CURRENCY.CREDIT, bonus, parseFloat(ur[0].credit),
    depositId, `Promo bonus: ${code}`
  );

  await client.query(
    'INSERT INTO promo_uses (promo_id, user_id, deposit_id, bonus_given) VALUES ($1, $2, $3, $4)',
    [pr[0].id, userId, depositId, bonus]
  );
  await client.query(
    'UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1',
    [pr[0].id]
  );
  return bonus;
}
