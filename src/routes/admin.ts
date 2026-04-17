import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../config/database';
import { adminAuthMiddleware, requireRole, AdminRequest } from '../middleware/adminAuth';
import { validate } from '../middleware/validate';
import { adminLimiter } from '../middleware/rateLimit';
import { GameEngine } from '../services/gameEngine';
import { AppError, ErrorCodes } from '../utils/errors';
import { env } from '../config/env';
import path from 'path';
import fs from 'fs';

const router = Router();

// ── Admin Login ───────────────────────────────────────────────
router.post('/auth/login', adminLimiter, async (req, res, next) => {
  try {
    const { username, password } = z.object({
      username: z.string().min(1),
      password: z.string().min(1),
    }).parse(req.body);

    const admin = await prisma.adminUser.findUnique({ where: { username } });
    if (!admin || !admin.isActive) throw new AppError(ErrorCodes.INVALID_CREDENTIALS, 401);
    const match = await bcrypt.compare(password, admin.passwordHash);
    if (!match) throw new AppError(ErrorCodes.INVALID_CREDENTIALS, 401);

    await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
    const token = jwt.sign(
      { adminId: admin.id, role: admin.role },
      env.ADMIN_JWT_SECRET,
      { expiresIn: env.ADMIN_JWT_EXPIRES_IN as any }
    );
    res.json({ token, admin: { id: admin.id, username: admin.username, role: admin.role } });
  } catch (e) { next(e); }
});

// All routes below require admin auth
router.use(adminAuthMiddleware);

// ── Dashboard ─────────────────────────────────────────────────
router.get('/dashboard', async (_req, res, next) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now.getTime() - 7 * 86400000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalUsers, demoUsers, activeToday,
      pendingDeposits, pendingWithdrawals,
      ggrToday, ggrWeek, ggrMonth,
      currentRound,
    ] = await prisma.$transaction([
      prisma.user.count(),
      prisma.user.count({ where: { accountType: 'DEMO' } }),
      prisma.user.count({ where: { lastSeenAt: { gte: new Date(Date.now() - 86400000) } } }),
      prisma.transaction.count({ where: { type: 'DEPOSIT', status: 'PENDING' } }),
      prisma.transaction.count({ where: { type: 'WITHDRAWAL', status: 'PENDING' } }),
      prisma.round.aggregate({ where: { createdAt: { gte: todayStart } }, _sum: { totalBetsReal: true, totalPayoutReal: true } }),
      prisma.round.aggregate({ where: { createdAt: { gte: weekStart } }, _sum: { totalBetsReal: true, totalPayoutReal: true } }),
      prisma.round.aggregate({ where: { createdAt: { gte: monthStart } }, _sum: { totalBetsReal: true, totalPayoutReal: true } }),
      prisma.round.findFirst({ where: { status: { in: ['WAITING', 'FLYING'] } }, orderBy: { id: 'desc' } }),
    ]);

    const calcGGR = (agg: any) => {
      const bets = agg._sum.totalBetsReal || 0n;
      const payout = agg._sum.totalPayoutReal || 0n;
      return (bets - payout).toString();
    };

    const pendingDepositAmount = await prisma.transaction.aggregate({
      where: { type: 'DEPOSIT', status: 'PENDING' },
      _sum: { amount: true },
    });
    const pendingWithdrawalAmount = await prisma.transaction.aggregate({
      where: { type: 'WITHDRAWAL', status: 'PENDING' },
      _sum: { amount: true },
    });

    res.json({
      users: { total: totalUsers, demo: demoUsers, real: totalUsers - demoUsers, activeToday },
      pendingDeposits: { count: pendingDeposits, amount: pendingDepositAmount._sum.amount || 0n },
      pendingWithdrawals: { count: pendingWithdrawals, amount: pendingWithdrawalAmount._sum.amount || 0n },
      ggr: { today: calcGGR(ggrToday), week: calcGGR(ggrWeek), month: calcGGR(ggrMonth) },
      currentRound: currentRound ? { id: currentRound.id, status: currentRound.status } : null,
      gameState: GameEngine.getInstance().getState(),
    });
  } catch (e) { next(e); }
});

// ── User Management ───────────────────────────────────────────
router.get('/users', async (req: AdminRequest, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
    const search = req.query.search as string | undefined;
    const type = req.query.type as string | undefined;

    const where: any = {};
    if (search) where.username = { contains: search, mode: 'insensitive' };
    if (type === 'real') where.accountType = 'REAL';
    if (type === 'demo') where.accountType = 'DEMO';

    const [users, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        select: {
          id: true, username: true, accountType: true, balance: true,
          bonusBalance: true, isActive: true, createdAt: true, lastSeenAt: true,
          _count: { select: { bets: true, referrals: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ users, total, page, limit });
  } catch (e) { next(e); }
});

router.get('/users/:id', async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        _count: { select: { bets: true, referrals: true } },
        ipLogs: { orderBy: { createdAt: 'desc' }, take: 10 },
        balanceLogs: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    if (!user) throw new AppError(ErrorCodes.USER_NOT_FOUND, 404);
    const { passwordHash, clientSeed, ...safe } = user;
    res.json(safe);
  } catch (e) { next(e); }
});

router.patch('/users/:id/type', requireRole('SUPERADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const { accountType } = z.object({ accountType: z.enum(['REAL', 'DEMO']) }).parse(req.body);
    await prisma.user.update({ where: { id: userId }, data: { accountType } });
    res.json({ success: true, accountType });
  } catch (e) { next(e); }
});

router.patch('/users/:id/balance', requireRole('SUPERADMIN', 'MANAGER'), async (req: AdminRequest, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const { balance, reason } = z.object({
      balance: z.number().int().min(0),
      reason: z.string().min(1),
    }).parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { balance: true } });
    if (!user) throw new AppError(ErrorCodes.USER_NOT_FOUND, 404);

    const bigBalance = BigInt(balance);
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { balance: bigBalance } }),
      prisma.balanceLog.create({
        data: { userId, adminId: req.adminId, before: user.balance, after: bigBalance, reason },
      }),
    ]);
    res.json({ success: true, balance: bigBalance });
  } catch (e) { next(e); }
});

router.patch('/users/:id/ban', requireRole('SUPERADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const { banned } = z.object({ banned: z.boolean() }).parse(req.body);
    await prisma.user.update({ where: { id: userId }, data: { isActive: !banned } });
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.get('/users/:id/bets', async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const bets = await prisma.bet.findMany({
      where: { userId },
      include: { round: { select: { id: true, crashPointReal: true, crashPointDemo: true, status: true } } },
      orderBy: { placedAt: 'desc' },
      skip: (page - 1) * 20,
      take: 20,
    });
    res.json(bets);
  } catch (e) { next(e); }
});

// ── Deposits ──────────────────────────────────────────────────
router.get('/deposits', requireRole('SUPERADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
    const status = req.query.status as string | undefined;
    const method = req.query.method as string | undefined;

    const where: any = { type: 'DEPOSIT' };
    if (status) where.status = status;
    if (method) where.method = method;

    const [items, total] = await prisma.$transaction([
      prisma.transaction.findMany({
        where,
        include: {
          user: { select: { id: true, username: true, accountType: true } },
          card: { select: { cardNumber: true, ownerName: true, method: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.transaction.count({ where }),
    ]);
    res.json({ items, total, page, limit });
  } catch (e) { next(e); }
});

router.get('/deposits/:id/cheque', requireRole('SUPERADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const tx = await prisma.transaction.findUnique({
      where: { id: parseInt(req.params.id) },
      select: { chequeFile: true },
    });
    if (!tx?.chequeFile) return res.status(404).json({ code: 'NOT_FOUND' });
    const filePath = path.join(env.UPLOAD_DIR || './uploads', tx.chequeFile);
    if (!fs.existsSync(filePath)) return res.status(404).json({ code: 'NOT_FOUND' });
    res.sendFile(path.resolve(filePath));
  } catch (e) { next(e); }
});

router.post('/deposits/:id/approve', requireRole('SUPERADMIN', 'MANAGER'), async (req: AdminRequest, res, next) => {
  try {
    const txId = parseInt(req.params.id);
    const tx = await prisma.transaction.findUnique({ where: { id: txId } });
    if (!tx || tx.type !== 'DEPOSIT') throw new AppError(ErrorCodes.TRANSACTION_NOT_FOUND, 404);
    if (tx.status !== 'PENDING') throw new AppError(ErrorCodes.ALREADY_PROCESSED, 400);

    // Apply deposit match promo if exists
    let bonusGrantId: number | undefined;
    if (tx.promoCode) {
      const promo = await prisma.promoCode.findUnique({ where: { code: tx.promoCode } });
      if (promo && promo.isActive && promo.type === 'DEPOSIT_MATCH') {
        let bonusAmount = BigInt(Math.round(Number(tx.amount) * (promo.value / 100)));
        if (promo.maxBonusUZS && bonusAmount > promo.maxBonusUZS) bonusAmount = promo.maxBonusUZS;
        const wageringRequired = BigInt(Math.round(Number(bonusAmount) * promo.wageringMultiplier));
        const grant = await prisma.bonusGrant.create({
          data: { userId: tx.userId, promoCodeId: promo.id, type: 'DEPOSIT_MATCH', bonusAmount, wageringRequired },
        });
        await prisma.user.update({ where: { id: tx.userId }, data: { bonusBalance: { increment: bonusAmount } } });
        await prisma.promoCode.update({ where: { id: promo.id }, data: { usageCount: { increment: 1 } } });
        bonusGrantId = grant.id;
      }
    }

    await prisma.$transaction([
      prisma.transaction.update({
        where: { id: txId },
        data: { status: 'APPROVED', processedAt: new Date(), processedBy: req.adminId, bonusGrantId },
      }),
      prisma.user.update({ where: { id: tx.userId }, data: { balance: { increment: tx.amount } } }),
    ]);

    res.json({ success: true });
  } catch (e) { next(e); }
});

router.post('/deposits/:id/reject', requireRole('SUPERADMIN', 'MANAGER'), async (req: AdminRequest, res, next) => {
  try {
    const txId = parseInt(req.params.id);
    const { reason } = z.object({ reason: z.string().optional() }).parse(req.body);
    const tx = await prisma.transaction.findUnique({ where: { id: txId } });
    if (!tx || tx.status !== 'PENDING') throw new AppError(ErrorCodes.ALREADY_PROCESSED, 400);

    // Refund card usage
    if (tx.cardId) {
      await prisma.p2PCard.update({ where: { id: tx.cardId }, data: { usedToday: { decrement: tx.amount } } });
    }

    await prisma.transaction.update({
      where: { id: txId },
      data: { status: 'REJECTED', adminNote: reason, processedAt: new Date(), processedBy: req.adminId },
    });
    res.json({ success: true });
  } catch (e) { next(e); }
});

// ── Withdrawals ───────────────────────────────────────────────
router.get('/withdrawals', requireRole('SUPERADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
    const status = req.query.status as string | undefined;

    const where: any = { type: 'WITHDRAWAL' };
    if (status) where.status = status;

    const [items, total] = await prisma.$transaction([
      prisma.transaction.findMany({
        where,
        include: { user: { select: { id: true, username: true, accountType: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.transaction.count({ where }),
    ]);
    res.json({ items, total, page, limit });
  } catch (e) { next(e); }
});

router.post('/withdrawals/:id/approve', requireRole('SUPERADMIN', 'MANAGER'), async (req: AdminRequest, res, next) => {
  try {
    const txId = parseInt(req.params.id);
    const tx = await prisma.transaction.findUnique({ where: { id: txId }, include: { user: { select: { accountType: true } } } });
    if (!tx || tx.type !== 'WITHDRAWAL') throw new AppError(ErrorCodes.TRANSACTION_NOT_FOUND, 404);
    if (tx.status !== 'PENDING') throw new AppError(ErrorCodes.ALREADY_PROCESSED, 400);

    await prisma.transaction.update({
      where: { id: txId },
      data: { status: 'APPROVED', processedAt: new Date(), processedBy: req.adminId },
    });
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.post('/withdrawals/:id/reject', requireRole('SUPERADMIN', 'MANAGER'), async (req: AdminRequest, res, next) => {
  try {
    const txId = parseInt(req.params.id);
    const { reason } = z.object({ reason: z.string().optional() }).parse(req.body);
    const tx = await prisma.transaction.findUnique({ where: { id: txId } });
    if (!tx || tx.type !== 'WITHDRAWAL') throw new AppError(ErrorCodes.TRANSACTION_NOT_FOUND, 404);
    if (tx.status !== 'PENDING') throw new AppError(ErrorCodes.ALREADY_PROCESSED, 400);

    await prisma.$transaction([
      prisma.transaction.update({
        where: { id: txId },
        data: { status: 'REJECTED', adminNote: reason, processedAt: new Date(), processedBy: req.adminId },
      }),
      prisma.user.update({ where: { id: tx.userId }, data: { balance: { increment: tx.amount } } }),
    ]);
    res.json({ success: true });
  } catch (e) { next(e); }
});

// ── P2P Cards ─────────────────────────────────────────────────
router.get('/cards', requireRole('SUPERADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const method = req.query.method as string | undefined;
    const where: any = {};
    if (method) where.method = method;
    if (req.query.isActive !== undefined) where.isActive = req.query.isActive === 'true';
    const cards = await prisma.p2PCard.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json(cards);
  } catch (e) { next(e); }
});

router.post('/cards', requireRole('SUPERADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const data = z.object({
      cardNumber: z.string().min(12).max(20),
      ownerName: z.string().min(2).max(100),
      method: z.enum(['CLICK', 'PAYME', 'PAYNET', 'HUMO', 'UZCARD']),
      dailyLimit: z.number().int().positive().default(10000000),
    }).parse(req.body);
    const card = await prisma.p2PCard.create({ data: { ...data, dailyLimit: BigInt(data.dailyLimit) } });
    res.status(201).json(card);
  } catch (e) { next(e); }
});

router.patch('/cards/:id', requireRole('SUPERADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const data = z.object({
      ownerName: z.string().optional(),
      dailyLimit: z.number().int().positive().optional(),
      isActive: z.boolean().optional(),
    }).parse(req.body);
    const updated = await prisma.p2PCard.update({
      where: { id },
      data: { ...data, ...(data.dailyLimit ? { dailyLimit: BigInt(data.dailyLimit) } : {}) },
    });
    res.json(updated);
  } catch (e) { next(e); }
});

router.delete('/cards/:id', requireRole('SUPERADMIN'), async (req, res, next) => {
  try {
    await prisma.p2PCard.update({ where: { id: parseInt(req.params.id) }, data: { isActive: false } });
    res.json({ success: true });
  } catch (e) { next(e); }
});

// ── Promo Codes ───────────────────────────────────────────────
router.get('/promos', async (req: AdminRequest, res, next) => {
  try {
    const promos = await prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(promos);
  } catch (e) { next(e); }
});

router.post('/promos', requireRole('SUPERADMIN', 'MANAGER'), async (req: AdminRequest, res, next) => {
  try {
    const data = z.object({
      code: z.string().min(3).max(50).toUpperCase(),
      type: z.enum(['DEPOSIT_MATCH', 'FIXED_CREDIT']),
      value: z.number().positive(),
      maxBonusUZS: z.number().int().positive().optional(),
      wageringMultiplier: z.number().min(1).default(3),
      expiresAt: z.string().datetime().optional(),
      maxUsage: z.number().int().positive().optional(),
    }).parse(req.body);

    const promo = await prisma.promoCode.create({
      data: {
        ...data,
        maxBonusUZS: data.maxBonusUZS ? BigInt(data.maxBonusUZS) : null,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        createdBy: req.adminId!,
      },
    });
    res.status(201).json(promo);
  } catch (e) { next(e); }
});

router.patch('/promos/:id', requireRole('SUPERADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const data = z.object({
      isActive: z.boolean().optional(),
      maxUsage: z.number().int().positive().nullable().optional(),
      expiresAt: z.string().datetime().nullable().optional(),
      wageringMultiplier: z.number().min(1).optional(),
    }).parse(req.body);
    const updated = await prisma.promoCode.update({ where: { id }, data });
    res.json(updated);
  } catch (e) { next(e); }
});

// ── Game Management ───────────────────────────────────────────
router.get('/game/rounds', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
    const [rounds, total] = await prisma.$transaction([
      prisma.round.findMany({
        orderBy: { id: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.round.count(),
    ]);
    res.json({ rounds, total, page, limit });
  } catch (e) { next(e); }
});

router.post('/game/stop', requireRole('SUPERADMIN', 'MANAGER'), async (_req, res, next) => {
  try {
    await GameEngine.getInstance().stop();
    res.json({ success: true, status: 'STOPPED' });
  } catch (e) { next(e); }
});

router.post('/game/start', requireRole('SUPERADMIN', 'MANAGER'), async (_req, res, next) => {
  try {
    await GameEngine.getInstance().resume();
    res.json({ success: true, status: 'RUNNING' });
  } catch (e) { next(e); }
});

router.patch('/game/config', requireRole('SUPERADMIN'), async (req, res, next) => {
  try {
    const data = z.object({
      minBet: z.number().int().positive().optional(),
      maxBet: z.number().int().positive().optional(),
      waitingPhaseSec: z.number().int().min(3).max(30).optional(),
      motivationFreq: z.number().int().min(1).max(100).optional(),
    }).parse(req.body);
    const config = await prisma.gameConfig.update({
      where: { id: 1 },
      data: {
        ...(data.minBet ? { minBet: BigInt(data.minBet) } : {}),
        ...(data.maxBet ? { maxBet: BigInt(data.maxBet) } : {}),
        ...(data.waitingPhaseSec ? { waitingPhaseSec: data.waitingPhaseSec } : {}),
        ...(data.motivationFreq ? { motivationFreq: data.motivationFreq } : {}),
      },
    });
    res.json(config);
  } catch (e) { next(e); }
});

// ── Reports ───────────────────────────────────────────────────
router.get('/reports/ggr', async (req, res, next) => {
  try {
    const period = (req.query.period as string) || 'day';
    const now = new Date();
    let since: Date;
    let groupBy: string;
    if (period === 'day') { since = new Date(now.getTime() - 30 * 86400000); groupBy = 'day'; }
    else if (period === 'week') { since = new Date(now.getTime() - 12 * 7 * 86400000); groupBy = 'week'; }
    else { since = new Date(now.getFullYear() - 1, 0, 1); groupBy = 'month'; }

    const rounds = await prisma.round.findMany({
      where: { createdAt: { gte: since }, status: 'CRASHED' },
      select: { createdAt: true, totalBetsReal: true, totalPayoutReal: true, totalBetsDemo: true, totalPayoutDemo: true },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ rounds, period });
  } catch (e) { next(e); }
});

router.get('/reports/payments', async (_req, res, next) => {
  try {
    const stats = await prisma.transaction.groupBy({
      by: ['method', 'type', 'status'],
      _sum: { amount: true },
      _count: true,
      where: { status: 'APPROVED' },
    });
    res.json(stats);
  } catch (e) { next(e); }
});

router.get('/reports/top-users', async (req, res, next) => {
  try {
    const type = (req.query.type as string) || 'real';
    const accountType = type === 'demo' ? 'DEMO' : 'REAL';
    const users = await prisma.bet.groupBy({
      by: ['userId'],
      where: { user: { accountType }, cashedOut: true, winAmount: { gt: 0 } },
      _sum: { winAmount: true, betAmount: true },
      _count: true,
      orderBy: { _sum: { winAmount: 'desc' } },
      take: 50,
    });
    res.json(users);
  } catch (e) { next(e); }
});

router.get('/reports/referrals', async (_req, res, next) => {
  try {
    const stats = await prisma.referralEarning.groupBy({
      by: ['referrerId'],
      _sum: { commission: true, houseProfit: true },
      _count: true,
      orderBy: { _sum: { commission: 'desc' } },
      take: 50,
    });
    res.json(stats);
  } catch (e) { next(e); }
});

// ── Chat Moderation ───────────────────────────────────────────
router.get('/chat', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const messages = await prisma.chatMessage.findMany({
      include: { user: { select: { id: true, username: true, accountType: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * 50,
      take: 50,
    });
    res.json(messages);
  } catch (e) { next(e); }
});

router.delete('/chat/:id', requireRole('SUPERADMIN', 'MANAGER', 'SUPPORT'), async (_req, res, next) => {
  try {
    await prisma.chatMessage.update({ where: { id: parseInt(_req.params.id) }, data: { isDeleted: true } });
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.post('/chat/ban', requireRole('SUPERADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const { userId, duration } = z.object({
      userId: z.number().int(),
      duration: z.enum(['24h', 'permanent']),
    }).parse(req.body);

    const banUntil = duration === 'permanent' ? new Date('2099-01-01') : new Date(Date.now() + 86400000);
    await prisma.user.update({ where: { id: userId }, data: { isChatBanned: true, chatBanUntil: banUntil } });
    res.json({ success: true });
  } catch (e) { next(e); }
});

// ── Admin User Management (Superadmin only) ───────────────────
router.get('/admins', requireRole('SUPERADMIN'), async (_req, res, next) => {
  try {
    const admins = await prisma.adminUser.findMany({
      select: { id: true, username: true, role: true, isActive: true, createdAt: true, lastLoginAt: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json(admins);
  } catch (e) { next(e); }
});

router.post('/admins', requireRole('SUPERADMIN'), async (req, res, next) => {
  try {
    const { username, password, role } = z.object({
      username: z.string().min(3).max(30),
      password: z.string().min(8),
      role: z.enum(['SUPERADMIN', 'MANAGER', 'SUPPORT']),
    }).parse(req.body);
    const passwordHash = await bcrypt.hash(password, 12);
    const admin = await prisma.adminUser.create({
      data: { username, passwordHash, role },
      select: { id: true, username: true, role: true, createdAt: true },
    });
    res.status(201).json(admin);
  } catch (e) { next(e); }
});

router.patch('/admins/:id', requireRole('SUPERADMIN'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const data = z.object({
      role: z.enum(['SUPERADMIN', 'MANAGER', 'SUPPORT']).optional(),
      isActive: z.boolean().optional(),
      password: z.string().min(8).optional(),
    }).parse(req.body);

    const update: any = {};
    if (data.role) update.role = data.role;
    if (data.isActive !== undefined) update.isActive = data.isActive;
    if (data.password) update.passwordHash = await bcrypt.hash(data.password, 12);

    await prisma.adminUser.update({ where: { id }, data: update });
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.delete('/admins/:id', requireRole('SUPERADMIN'), async (req, res, next) => {
  try {
    await prisma.adminUser.update({ where: { id: parseInt(req.params.id) }, data: { isActive: false } });
    res.json({ success: true });
  } catch (e) { next(e); }
});

export default router;
