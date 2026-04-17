import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import './utils/bigint'; // BigInt patch
import { globalLimiter } from './middleware/rateLimit';
import { AppError } from './utils/errors';
import authRoutes from './routes/auth';
import gameRoutes from './routes/game';
import walletRoutes from './routes/wallet';
import userRoutes from './routes/user';
import bonusRoutes from './routes/bonus';
import adminRoutes from './routes/admin';
import { env } from './config/env';

export const app = express();
app.set('trust proxy', 1);

// ── Security ──────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: (origin, callback) => {
    const allowed = env.CORS_ORIGINS.split(',').map(o => o.trim());
    if (!origin || allowed.includes(origin) || allowed.includes('*')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(globalLimiter);

// ── Health ────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ── API Routes ────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/game', gameRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/user', userRoutes);
app.use('/api/bonus', bonusRoutes);
app.use('/api/admin', adminRoutes);

// ── Static: uploads (cheque files) ───────────────────────────
app.use('/uploads', express.static(path.join(process.cwd(), env.UPLOAD_DIR || 'uploads')));

// ── 404 for unknown routes ────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
});

// ── Error Handler ─────────────────────────────────────────────
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({ code: err.code, message: err.message });
  }
  if (err.name === 'ZodError') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.flatten?.()?.fieldErrors });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
});
