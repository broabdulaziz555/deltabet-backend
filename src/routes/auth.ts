import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../config/database';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { authLimiter } from '../middleware/rateLimit';
import { AppError, ErrorCodes } from '../utils/errors';
import { getClientIp } from '../utils/mask';
import { env } from '../config/env';

const router = Router();

const registerSchema = z.object({
  username: z.string().min(8).max(50),
  password: z.string().min(8),
  lang: z.enum(['uz', 'ru', 'en']).optional().default('uz'),
  referralCode: z.string().optional(),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

router.post('/register', authLimiter, validate(registerSchema), async (req, res, next) => {
  try {
    const { username, password, lang, referralCode } = req.body;

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) throw new AppError(ErrorCodes.USERNAME_TAKEN, 409);

    let referredById: number | undefined;
    if (referralCode) {
      const referrer = await prisma.user.findUnique({ where: { referralCode } });
      if (referrer) referredById = referrer.id;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { username, passwordHash, lang, referredById },
      select: { id: true, username: true, accountType: true, balance: true, bonusBalance: true, referralCode: true, lang: true },
    });

    const token = jwt.sign(
      { userId: user.id, accountType: user.accountType },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN as any }
    );

    res.status(201).json({ token, user });
  } catch (e) {
    next(e);
  }
});

router.post('/login', authLimiter, validate(loginSchema), async (req: AuthRequest, res, next) => {
  try {
    const { username, password } = req.body;
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) throw new AppError(ErrorCodes.INVALID_CREDENTIALS, 401);
    if (!user.isActive) throw new AppError(ErrorCodes.ACCOUNT_BANNED, 403);

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) throw new AppError(ErrorCodes.INVALID_CREDENTIALS, 401);

    await prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } });
    await prisma.ipLog.create({
      data: { userId: user.id, ip: getClientIp(req), userAgent: req.headers['user-agent'] },
    });

    const token = jwt.sign(
      { userId: user.id, accountType: user.accountType },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN as any }
    );

    res.json({
      token,
      user: {
        id: user.id, username: user.username, accountType: user.accountType,
        balance: user.balance, bonusBalance: user.bonusBalance,
        referralCode: user.referralCode, lang: user.lang,
      },
    });
  } catch (e) {
    next(e);
  }
});

router.get('/me', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true, username: true, accountType: true, balance: true,
        bonusBalance: true, referralCode: true, lang: true, createdAt: true,
      },
    });
    if (!user) throw new AppError(ErrorCodes.USER_NOT_FOUND, 404);
    res.json(user);
  } catch (e) {
    next(e);
  }
});

router.patch('/lang', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const { lang } = z.object({ lang: z.enum(['uz', 'ru', 'en']) }).parse(req.body);
    await prisma.user.update({ where: { id: req.userId }, data: { lang } });
    res.json({ lang });
  } catch (e) {
    next(e);
  }
});

export default router;
