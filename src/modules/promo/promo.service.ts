import { pool, withTransaction } from '../../db/pool';
import { AppError, paginate, paginatedResponse } from '../../utils/helpers';
import { t, Lang } from '../i18n/translations';

// ─── Shared helper ────────────────────────────────────────────────────────────

/**
 * Fetch a single promo with its tiers attached.
 * Used internally so every write operation returns a consistent full object.
 */
async function getPromoWithTiers(promoId: string) {
  const { rows } = await pool.query(
    `SELECT
       p.*,
       COALESCE(
         json_agg(
           json_build_object(
             'id',          t.id,
             'minDeposit',  t.min_deposit,
             'bonusType',   t.bonus_type,
             'bonusValue',  t.bonus_value,
             'sortOrder',   t.sort_order
           ) ORDER BY t.sort_order, t.min_deposit
         ) FILTER (WHERE t.id IS NOT NULL),
         '[]'
       ) AS tiers
     FROM promo_codes p
     LEFT JOIN promo_tiers t ON t.promo_id = p.id
     WHERE p.id = $1
     GROUP BY p.id`,
    [promoId]
  );
  if (!rows[0]) throw new AppError(404, 'Promo not found');
  return rows[0];
}

// ─── User-facing ──────────────────────────────────────────────────────────────

export async function validatePromoPreview(
  code: string,
  depositAmount: number,
  lang: Lang = 'ru'
) {
  const { rows: pr } = await pool.query(
    `SELECT * FROM promo_codes
     WHERE UPPER(code) = UPPER($1) AND is_active = true
     AND (expires_at IS NULL OR expires_at > now())
     AND (max_uses IS NULL OR used_count < max_uses)`,
    [code]
  );
  if (!pr[0]) throw new AppError(400, t('invalidPromo', lang));

  const { rows: tiers } = await pool.query(
    `SELECT * FROM promo_tiers
     WHERE promo_id = $1 AND min_deposit <= $2
     ORDER BY min_deposit DESC LIMIT 1`,
    [pr[0].id, depositAmount]
  );

  if (!tiers[0]) {
    return {
      valid: true,
      code: pr[0].code,
      bonus: 0,
      message: 'Deposit amount does not meet any tier minimum',
    };
  }

  const bonus = tiers[0].bonus_type === 'percent'
    ? Math.floor(depositAmount * (parseFloat(tiers[0].bonus_value) / 100))
    : parseFloat(tiers[0].bonus_value);

  return {
    valid:      true,
    code:       pr[0].code,
    bonus,
    bonusType:  tiers[0].bonus_type  as string,
    bonusValue: parseFloat(tiers[0].bonus_value),
  };
}

// ─── Admin: list ──────────────────────────────────────────────────────────────

export async function adminListPromos(opts: {
  page?:     number;
  limit?:    number;
  search?:   string;    // filter by code (partial, case-insensitive)
  isActive?: boolean;   // filter by active status
}) {
  const { page = 1, limit = 20, search, isActive } = opts;
  const { limit: l, offset, page: p } = paginate(page, limit);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (search) {
    params.push(`%${search.toUpperCase()}%`);
    conditions.push(`UPPER(p.code) LIKE $${params.length}`);
  }
  if (isActive !== undefined) {
    params.push(isActive);
    conditions.push(`p.is_active = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [{ rows }, { rows: cnt }] = await Promise.all([
    pool.query(
      `SELECT
         p.*,
         COALESCE(
           json_agg(
             json_build_object(
               'id',         t.id,
               'minDeposit', t.min_deposit,
               'bonusType',  t.bonus_type,
               'bonusValue', t.bonus_value,
               'sortOrder',  t.sort_order
             ) ORDER BY t.sort_order, t.min_deposit
           ) FILTER (WHERE t.id IS NOT NULL),
           '[]'
         ) AS tiers,
         (SELECT COUNT(*)::int FROM promo_uses pu WHERE pu.promo_id = p.id) AS use_count,
         (SELECT COALESCE(SUM(bonus_given), 0) FROM promo_uses pu WHERE pu.promo_id = p.id) AS total_bonus_given
       FROM promo_codes p
       LEFT JOIN promo_tiers t ON t.promo_id = p.id
       ${where}
       GROUP BY p.id
       ORDER BY p.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, l, offset]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM promo_codes p ${where}`,
      params
    ),
  ]);

  return paginatedResponse(rows, cnt[0].total, p, l);
}

// ─── Admin: single promo ──────────────────────────────────────────────────────

export async function adminGetPromo(promoId: string) {
  const promo = await getPromoWithTiers(promoId);

  // Attach usage stats
  const { rows: stats } = await pool.query(
    `SELECT
       COUNT(*)::int                        AS total_uses,
       COALESCE(SUM(bonus_given), 0)        AS total_bonus_given,
       json_agg(
         json_build_object(
           'userId',    pu.user_id,
           'username',  u.username,
           'bonusGiven', pu.bonus_given,
           'usedAt',    pu.used_at
         ) ORDER BY pu.used_at DESC
       ) FILTER (WHERE pu.id IS NOT NULL) AS recent_uses
     FROM promo_uses pu
     JOIN users u ON u.id = pu.user_id
     WHERE pu.promo_id = $1`,
    [promoId]
  );

  return { ...promo, stats: stats[0] };
}

// ─── Admin: create ────────────────────────────────────────────────────────────

export async function adminCreatePromo(data: {
  code:        string;
  description: string;
  maxUses:     number | null;
  expiresAt:   string | null;
  isActive:    boolean;
  tiers:       Array<{ minDeposit: number; bonusType: 'percent' | 'fixed'; bonusValue: number }>;
}) {
  // Check duplicate
  const { rows: existing } = await pool.query(
    'SELECT id FROM promo_codes WHERE UPPER(code) = UPPER($1)',
    [data.code]
  );
  if (existing.length > 0) throw new AppError(409, `Promo code "${data.code.toUpperCase()}" already exists`);

  const promo = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO promo_codes (code, description, max_uses, expires_at, is_active)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [data.code.toUpperCase(), data.description, data.maxUses, data.expiresAt, data.isActive]
    );
    const p = rows[0];

    for (let i = 0; i < data.tiers.length; i++) {
      const { minDeposit, bonusType, bonusValue } = data.tiers[i];
      await client.query(
        `INSERT INTO promo_tiers (promo_id, min_deposit, bonus_type, bonus_value, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [p.id, minDeposit, bonusType, bonusValue, i]
      );
    }
    return p;
  });

  // Return full promo with tiers for immediate UI update
  return getPromoWithTiers(promo.id);
}

// ─── Admin: update ────────────────────────────────────────────────────────────

export async function adminUpdatePromo(
  promoId: string,
  data: {
    description?: string;
    isActive?:    boolean;
    maxUses?:     number | null;
    expiresAt?:   string | null;
  }
) {
  const allowed: Record<string, string> = {
    description: 'description',
    isActive:    'is_active',
    maxUses:     'max_uses',
    expiresAt:   'expires_at',
  };

  const fields: string[] = [];
  const params: unknown[] = [];

  for (const [key, col] of Object.entries(allowed)) {
    if (key in data) {
      params.push((data as Record<string, unknown>)[key]);
      fields.push(`${col} = $${params.length}`);
    }
  }

  if (!fields.length) throw new AppError(400, 'Nothing to update');

  params.push(promoId);
  const { rows } = await pool.query(
    `UPDATE promo_codes SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING id`,
    params
  );
  if (!rows[0]) throw new AppError(404, 'Promo not found');

  // Return full updated promo so UI can refresh in one shot
  return getPromoWithTiers(promoId);
}

// ─── Admin: toggle active ─────────────────────────────────────────────────────

export async function adminTogglePromo(promoId: string) {
  const { rows } = await pool.query(
    `UPDATE promo_codes SET is_active = NOT is_active WHERE id = $1 RETURNING id`,
    [promoId]
  );
  if (!rows[0]) throw new AppError(404, 'Promo not found');
  return getPromoWithTiers(promoId);
}

// ─── Admin: delete ────────────────────────────────────────────────────────────

export async function adminDeletePromo(promoId: string) {
  // Check if it has been used — if yes, soft delete (deactivate) to preserve history
  const { rows: uses } = await pool.query(
    'SELECT COUNT(*)::int AS cnt FROM promo_uses WHERE promo_id = $1',
    [promoId]
  );

  if (parseInt(uses[0].cnt) > 0) {
    // Has usage history — just deactivate, don't hard delete
    await pool.query(
      'UPDATE promo_codes SET is_active = false WHERE id = $1',
      [promoId]
    );
    return { deleted: false, deactivated: true, reason: 'Promo has usage history — deactivated instead of deleted' };
  }

  // No uses — safe to hard delete (cascades to tiers via FK ON DELETE CASCADE)
  await pool.query('DELETE FROM promo_codes WHERE id = $1', [promoId]);
  return { deleted: true, deactivated: false };
}

// ─── Admin: tiers ─────────────────────────────────────────────────────────────

export async function adminAddTier(
  promoId:   string,
  minDeposit: number,
  bonusType:  'percent' | 'fixed',
  bonusValue: number
) {
  // Check promo exists
  const { rows: pr } = await pool.query('SELECT id FROM promo_codes WHERE id = $1', [promoId]);
  if (!pr[0]) throw new AppError(404, 'Promo not found');

  await pool.query(
    `INSERT INTO promo_tiers (promo_id, min_deposit, bonus_type, bonus_value)
     VALUES ($1, $2, $3, $4)`,
    [promoId, minDeposit, bonusType, bonusValue]
  );

  return getPromoWithTiers(promoId);
}

export async function adminUpdateTier(
  promoId: string,
  tierId:  number,
  data: { minDeposit?: number; bonusType?: 'percent' | 'fixed'; bonusValue?: number }
) {
  const fields: string[] = [];
  const params: unknown[] = [];

  if (data.minDeposit !== undefined) { params.push(data.minDeposit); fields.push(`min_deposit = $${params.length}`); }
  if (data.bonusType  !== undefined) { params.push(data.bonusType);  fields.push(`bonus_type  = $${params.length}`); }
  if (data.bonusValue !== undefined) { params.push(data.bonusValue); fields.push(`bonus_value = $${params.length}`); }

  if (!fields.length) throw new AppError(400, 'Nothing to update');

  params.push(tierId);
  const { rows } = await pool.query(
    `UPDATE promo_tiers SET ${fields.join(', ')} WHERE id = $${params.length} AND promo_id = $${params.length + 1} RETURNING id`,
    [...params, promoId]
  );
  if (!rows[0]) throw new AppError(404, 'Tier not found');

  return getPromoWithTiers(promoId);
}

export async function adminDeleteTier(promoId: string, tierId: number) {
  const { rows } = await pool.query(
    'DELETE FROM promo_tiers WHERE id = $1 AND promo_id = $2 RETURNING id',
    [tierId, promoId]
  );
  if (!rows[0]) throw new AppError(404, 'Tier not found');
  return getPromoWithTiers(promoId); // return updated promo
}
