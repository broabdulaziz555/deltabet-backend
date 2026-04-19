import { pool } from './pool';
import { logger } from '../utils/logger';

/**
 * On server restart, settle any bets stuck in 'active' status
 * from rounds that are already 'crashed'.
 * This happens when the server crashes mid-round.
 */
export async function settleOrphanedBets(): Promise<void> {
  const { rows: orphaned } = await pool.query(
    `SELECT b.id, b.user_id, b.amount, b.currency_type, b.round_id
     FROM bets b
     JOIN game_rounds gr ON gr.id = b.round_id
     WHERE b.status = 'active'
     AND gr.status = 'crashed'`
  );

  if (orphaned.length === 0) {
    logger.info('No orphaned bets found');
    return;
  }

  logger.warn('Settling orphaned bets', { count: orphaned.length });

  await pool.query(
    `UPDATE bets SET status = 'lost'
     WHERE status = 'active'
     AND round_id IN (
       SELECT id FROM game_rounds WHERE status = 'crashed'
     )`
  );

  logger.info('Orphaned bets settled as lost', { count: orphaned.length });
}

/**
 * Mark any 'active' rounds as 'crashed' if the server was down.
 * Prevents rounds from being stuck in 'active' state forever.
 */
export async function settleOrphanedRounds(): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE game_rounds
     SET status = 'crashed', crashed_at = now()
     WHERE status = 'active'
     AND started_at < now() - interval '10 minutes'`
  );
  if (rowCount && rowCount > 0) {
    logger.warn('Settled orphaned rounds', { count: rowCount });
  }
}
