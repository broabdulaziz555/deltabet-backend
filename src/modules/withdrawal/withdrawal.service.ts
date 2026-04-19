import { pool, withTransaction } from '../../db/pool';
import { LIMITS, PAYMENT_METHODS, CURRENCY } from '../../config/constants';
import { AppError, paginate, paginatedResponse } from '../../utils/helpers';
import { writeLedger } from '../wallet/wallet.service';
import { t, Lang }    from '../i18n/translations';
import { sendTelegramMessage, msgWithdrawalApproved, msgWithdrawalRejected } from '../../utils/telegram';

export async function createWithdrawal(
  userId:        string,
  amount:        number,
  paymentMethod: string,
  cardNumber:    string,
  lang:          Lang = 'ru'
) {
  if (amount < LIMITS.MIN_WITHDRAWAL)                                   throw new AppError(400, t('minWithdrawal', lang));
  if (amount > LIMITS.MAX_TRANSACTION)                                   throw new AppError(400, 'Amount exceeds max limit');
  if (!(PAYMENT_METHODS as readonly string[]).includes(paymentMethod))   throw new AppError(400, 'Invalid payment method');

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT balance FROM users WHERE id = $1 FOR UPDATE', [userId]
    );
    if (!rows[0] || parseFloat(rows[0].balance) < amount) {
      throw new AppError(400, t('insufficientBalance', lang));
    }

    const { rows: ur } = await client.query(
      'UPDATE users SET balance = balance - $1, updated_at = now() WHERE id = $2 RETURNING balance',
      [amount, userId]
    );
    const { rows: wr } = await client.query(
      `INSERT INTO withdrawals (user_id, amount, payment_method, card_number)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [userId, amount, paymentMethod, cardNumber]
    );
    await writeLedger(client, userId, 'withdrawal', CURRENCY.BALANCE, -amount, parseFloat(ur[0].balance), wr[0].id);
    return wr[0];
  });
}

export async function getUserWithdrawals(userId: string, page = 1, limit = 20) {
  const { limit: l, offset, page: p } = paginate(page, limit);
  const [{ rows }, { rows: cnt }] = await Promise.all([
    pool.query(
      `SELECT id, amount, payment_method, card_number, status, admin_note, created_at, processed_at
       FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, l, offset]
    ),
    pool.query('SELECT COUNT(*)::int AS total FROM withdrawals WHERE user_id = $1', [userId]),
  ]);
  return paginatedResponse(rows, cnt[0].total, p, l);
}

export async function adminGetWithdrawals(page = 1, limit = 20, status?: string, from?: string, to?: string) {
  const { limit: l, offset, page: p } = paginate(page, limit);
  const params: unknown[] = [];
  const where = (() => { const conds: string[] = []; if (status) { params.push(status); conds.push(`w.status = $${params.length}`); } if (from) { params.push(from); conds.push(`w.created_at >= $${params.length}`); } if (to) { params.push(to); conds.push(`w.created_at <= $${params.length}`); } return conds.length ? "WHERE " + conds.join(" AND ") : ""; })();
  const [{ rows }, { rows: cnt }] = await Promise.all([
    pool.query(
      `SELECT w.*, u.username FROM withdrawals w
       JOIN users u ON u.id = w.user_id
       ${where} ORDER BY w.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, l, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM withdrawals w ${where}`, params),
  ]);
  return paginatedResponse(rows, cnt[0].total, p, l);
}

export async function adminApproveWithdrawal(withdrawalId: string, adminUsername: string) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [withdrawalId]
    );
    if (!rows[0]) throw new AppError(404, 'Withdrawal not found');
    if (rows[0].status !== 'pending') throw new AppError(400, 'Withdrawal already processed');

    await client.query(
      `UPDATE withdrawals SET status = 'approved', processed_at = now(), processed_by = $1 WHERE id = $2`,
      [adminUsername, withdrawalId]
    );
    await client.query(
      `INSERT INTO admin_logs (admin, action, target_user, details)
       VALUES ($1, 'approve_withdrawal', $2, $3)`,
      [adminUsername, rows[0].user_id, JSON.stringify({ withdrawalId, amount: rows[0].amount })]
    );
    // Notify user via Telegram
    const { rows: tgRows } = await client.query(
      'SELECT telegram_id FROM users WHERE id = $1', [rows[0].user_id]
    );
    sendTelegramMessage(
      tgRows[0]?.telegram_id,
      msgWithdrawalApproved(parseFloat(rows[0].amount))
    ).catch(() => {});

    return { approved: true };
  });
}

export async function adminRejectWithdrawal(withdrawalId: string, note: string, adminUsername: string) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [withdrawalId]
    );
    if (!rows[0]) throw new AppError(404, 'Withdrawal not found');
    if (rows[0].status !== 'pending') throw new AppError(400, 'Withdrawal already processed');

    // Refund balance
    const { rows: ur } = await client.query(
      'UPDATE users SET balance = balance + $1, updated_at = now() WHERE id = $2 RETURNING balance',
      [rows[0].amount, rows[0].user_id]
    );
    await writeLedger(
      client, rows[0].user_id, 'refund', CURRENCY.BALANCE,
      parseFloat(rows[0].amount), parseFloat(ur[0].balance),
      withdrawalId, 'Withdrawal rejected'
    );
    await client.query(
      `UPDATE withdrawals SET status = 'rejected', admin_note = $1,
       processed_at = now(), processed_by = $2 WHERE id = $3`,
      [note, adminUsername, withdrawalId]
    );
    await client.query(
      `INSERT INTO admin_logs (admin, action, target_user, details)
       VALUES ($1, 'reject_withdrawal', $2, $3)`,
      [adminUsername, rows[0].user_id, JSON.stringify({ withdrawalId, note })]
    );
    // Notify user via Telegram
    const { rows: tgRows } = await client.query(
      'SELECT telegram_id FROM users WHERE id = $1', [rows[0].user_id]
    );
    sendTelegramMessage(
      tgRows[0]?.telegram_id,
      msgWithdrawalRejected(parseFloat(rows[0].amount), note)
    ).catch(() => {});

    return { rejected: true };
  });
}
