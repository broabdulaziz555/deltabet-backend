import { Pool, PoolClient } from 'pg';
import { env }              from '../config/env';
import { logger }           from '../utils/logger';

export const pool = new Pool({
  connectionString:      env.DATABASE_URL,
  ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max:                   20,
  idleTimeoutMillis:     30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error('Unexpected DB pool error', { error: err.message });
});

/**
 * Wait for DB to be reachable — Railway PostgreSQL can take a few seconds
 * to accept connections after a deploy even though the URL is already set.
 */
export async function waitForDb(maxRetries = 15, delayMs = 2_000): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await pool.query('SELECT 1');
      logger.info('DB connected');
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === maxRetries) {
        throw new Error(`DB unreachable after ${maxRetries} attempts: ${msg}`);
      }
      logger.warn(`DB not ready (attempt ${attempt}/${maxRetries}), retrying in ${delayMs}ms...`, { error: msg });
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function checkDbConnection(): Promise<boolean> {
  try { await pool.query('SELECT 1'); return true; }
  catch { return false; }
}
