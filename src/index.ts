import './config/env';
import express, { Request, Response, NextFunction } from 'express';
import http    from 'http';
import helmet  from 'helmet';
import cors    from 'cors';
import rateLimit from 'express-rate-limit';

import { env }               from './config/env';
import { pool, waitForDb, checkDbConnection } from './db/pool';
import { gameManager }       from './ws/gameLoop';
import { createWsServer, attachGameEvents, getOnlineUserCount } from './ws/wsServer';
import { errorHandler }      from './middleware/errorHandler';
import { logger }            from './utils/logger';
import { settleOrphanedBets, settleOrphanedRounds } from './db/settle';

import authRouter       from './modules/auth/auth.router';
import walletRouter     from './modules/wallet/wallet.router';
import depositRouter    from './modules/deposit/deposit.router';
import withdrawalRouter from './modules/withdrawal/withdrawal.router';
import promoRouter      from './modules/promo/promo.router';
import gameRouter       from './modules/game/game.router';
import adminRouter      from './modules/admin/admin.router';

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();

app.use(helmet());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);          // native mobile — no Origin header
    if (env.NODE_ENV === 'development') return cb(null, true);
    if (env.ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '512kb' }));
app.set('trust proxy', 1);

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info('HTTP request', { method: req.method, path: req.path, ip: req.ip });
  next();
});

// ─── Rate limiters ─────────────────────────────────────────────────────────────

const authLimiter  = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
const apiLimiter   = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', async (_req: Request, res: Response) => {
  const dbConnected = await checkDbConnection();
  const wsClients   = getOnlineUserCount();
  res.status(dbConnected ? 200 : 503).json({
    status:     dbConnected ? 'ok' : 'degraded',
    uptime:     Math.floor(process.uptime()),
    dbConnected,
    wsClients,
    tables:     gameManager.getAllStates(),
    timestamp:  new Date().toISOString(),
    version:    process.env.npm_package_version ?? '1.0.0',
  });
});

app.get('/adminpanel', (req: Request, res: Response) => {
  if (req.query.key !== env.ADMIN_SECRET_KEY) { res.status(404).send('Not found'); return; }
  res.json({ message: 'Admin panel access granted', adminApiBase: '/admin' });
});

app.use('/api/auth',        authLimiter,  authRouter);
app.use('/api/wallet',      apiLimiter,   walletRouter);
app.use('/api/deposits',    apiLimiter,   depositRouter);
app.use('/api/withdrawals', apiLimiter,   withdrawalRouter);
app.use('/api/promo',       apiLimiter,   promoRouter);
app.use('/api/game',        apiLimiter,   gameRouter);
app.use('/admin',           adminLimiter, adminRouter);

app.use((_req: Request, res: Response) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler as (err: unknown, req: Request, res: Response, next: NextFunction) => void);

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(app);

async function start(): Promise<void> {
  logger.info('Starting DeltaBet backend...');

  // 1. Wait for DB to be ready (Railway PostgreSQL can take a few seconds)
  await waitForDb(15, 2_000);

  // 2. Attach WS server before listen
  createWsServer(server);

  // 3. Bind port
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(env.PORT, '0.0.0.0', resolve);
  });
  logger.info(`HTTP + WS listening on port ${env.PORT}`);

  // 4. Settle any bets/rounds orphaned by previous server crash
  await settleOrphanedRounds();
  await settleOrphanedBets();

  // 5. Init game loops
  await gameManager.init(env.TABLE_COUNT, env.BETTING_PHASE_MS, env.TICK_MS);

  // 6. Wire game events to WS
  attachGameEvents(gameManager.tables);

  // 7. Cleanup cron — remove expired blacklisted tokens every hour
  setInterval(async () => {
    try {
      const { rowCount } = await pool.query(
        'DELETE FROM refresh_token_blacklist WHERE expires_at < now()'
      );
      if (rowCount && rowCount > 0) logger.info('Cleaned expired refresh tokens', { count: rowCount });
    } catch (err: unknown) {
      logger.error('Token cleanup failed', { error: (err as Error).message });
    }
  }, 3_600_000);

  logger.info('DeltaBet backend ready');
}

function shutdown(): void {
  logger.info('Shutdown initiated...');
  gameManager.stop();
  server.close(() => {
    logger.info('Server closed cleanly');
    process.exit(0);
  });
  setTimeout(() => { logger.error('Force exit after timeout'); process.exit(1); }, 10_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
process.on('uncaughtException',  (err)    => { logger.error('Uncaught exception',   { error: err.message, stack: err.stack }); shutdown(); });
process.on('unhandledRejection', (reason) => { logger.error('Unhandled rejection',  { reason: String(reason) });              shutdown(); });

start().catch(err => { logger.error('Startup failed', { error: (err as Error).message }); process.exit(1); });
