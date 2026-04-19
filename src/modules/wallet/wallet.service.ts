import { PoolClient } from 'pg';
import { pool }       from '../../db/pool';
import { Currency }   from '../../config/constants';
import { paginate, paginatedResponse } from '../../utils/helpers';

export async function getWallet(userId: string) {
  const { rows } = await pool.query(
    'SELECT balance, credit FROM users WHERE id = $1',
    [userId]
  );
  return rows[0] ?? { balance: '0', credit: '0' };
}

export async function getLedger(userId: string, page = 1, limit = 20, type?: string) {
  const { limit: l, offset, page: p } = paginate(page, limit);
  const conditions = ['user_id = $1'];
  const params: unknown[] = [userId];

  if (type) {
    params.push(type);
    conditions.push(`type = $${params.length}`);
  }

  const where = conditions.join(' AND ');
  const [{ rows }, { rows: cnt }] = await Promise.all([
    pool.query(
      `SELECT id, type, currency, amount, balance_after, ref_id, note, created_at
       FROM balance_ledger
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, l, offset]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM balance_ledger WHERE ${where}`,
      params
    ),
  ]);
  return paginatedResponse(rows, cnt[0].total, p, l);
}

/**
 * Write an immutable ledger entry. Must be called inside a transaction.
 * currency: 'balance' (real UZS) | 'credit' (bonus UZS)
 */
export async function writeLedger(
  client:       PoolClient,
  userId:       string,
  type:         string,
  currency:     Currency,
  amount:       number,
  balanceAfter: number,
  refId?:       string,
  note?:        string
): Promise<void> {
  await client.query(
    `INSERT INTO balance_ledger
       (user_id, type, currency, amount, balance_after, ref_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, type, currency, amount, balanceAfter, refId ?? null, note ?? null]
  );
}
