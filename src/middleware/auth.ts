import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { pool } from '../db/pool';
import { Lang } from '../modules/i18n/translations';

export interface AuthUser {
  id: string;
  username: string;
  lang: Lang;
  account_type: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      admin?: { username: string };
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as {
      sub: string;
      username: string;
      lang: string;
      account_type: string;
    };
    const lang = (['ru', 'uz', 'en'] as string[]).includes(payload.lang)
      ? (payload.lang as Lang)
      : 'ru' as Lang;

    req.user = {
      id: payload.sub,
      username: payload.username,
      lang,
      account_type: payload.account_type ?? 'real',
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export async function requireAuthAndNotBanned(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  requireAuth(req, res, async () => {
    if (!req.user) return;
    try {
      const { rows } = await pool.query(
        'SELECT is_banned, ban_reason FROM users WHERE id = $1',
        [req.user.id]
      );
      if (!rows[0] || rows[0].is_banned) {
        res.status(403).json({ error: 'Account suspended', reason: rows[0]?.ban_reason ?? null });
        return;
      }
      next();
    } catch {
      res.status(500).json({ error: 'Auth check failed' });
    }
  });
}
