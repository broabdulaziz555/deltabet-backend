import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { betLimiter } from '../middleware/rateLimit';
import { GameEngine } from '../services/gameEngine';
import { AppError, ErrorCodes } from '../utils/errors';
import { maskUsername } from '../utils/mask';

const router = Router();

const betSchema = z.object({
  panelSlot: z.number().int().min(1).max(2),
  amount: z.number().int().positive(),
  autoCashout: z.number().min(1.01).max(1000).nullable().optional(),
});

const cashoutSchema = z.object({ panelSlot: z.number().int().min(1).max(2) });

router.post('/bet', authMiddleware, betLimiter, validate(betSchema), async (req: AuthRequest, res, next) => {
  try {
    const { panelSlot, amount, autoCashout } = req.body;
    const engine = GameEngine.getInstance();
    const result = await engine.placeBet(
      req.userId!,
      panelSlot as 1 | 2,
      BigInt(amount),
      autoCashout ?? null
    );
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post('/cashout', authMiddleware, betLimiter, validate(cashoutSchema), async (req: AuthRequest, res, next) => {
  try {
    const engine = GameEngine.getInstance();
    const result = await engine.cashout(req.userId!, req.body.panelSlot);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/state', async (_req, res, next) => {
  try {
    const engine = GameEngine.getInstance();
    res.json(engine.getState());
  } catch (e) {
    next(e);
  }
});

router.get('/round/current', async (_req, res, next) => {
  try {
    const round = await prisma.round.findFirst({
      where: { status: { in: ['WAITING', 'FLYING'] } },
      select: { id: true, status: true, serverSeedHash: true, startedAt: true, createdAt: true },
      orderBy: { id: 'desc' },
    });
    res.json(round || { status: 'CRASHED' });
  } catch (e) {
    next(e);
  }
});

router.get('/history', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
    const rounds = await prisma.round.findMany({
      where: { status: 'CRASHED' },
      select: {
        id: true, crashPointReal: true, serverSeedHash: true,
        totalBetsReal: true, totalPayoutReal: true, createdAt: true,
      },
      orderBy: { id: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    res.json(rounds);
  } catch (e) {
    next(e);
  }
});

router.get('/round/:roundId', async (req, res, next) => {
  try {
    const roundId = parseInt(req.params.roundId);
    const round = await prisma.round.findUnique({
      where: { id: roundId },
      include: {
        bets: {
          select: {
            panelSlot: true, betAmount: true, cashedOut: true,
            cashoutMultiplier: true, winAmount: true,
            user: { select: { username: true } },
          },
          where: { cashedOut: true, winAmount: { gt: 0 } },
          orderBy: { winAmount: 'desc' },
          take: 100,
        },
      },
    });
    if (!round) throw new AppError(ErrorCodes.NOT_FOUND, 404);
    const sanitized = {
      ...round,
      serverSeed: round.status === 'CRASHED' ? round.serverSeed : undefined,
      crashPointDemo: undefined,
      bets: round.bets.map(b => ({
        ...b,
        user: { username: maskUsername(b.user.username) },
      })),
    };
    res.json(sanitized);
  } catch (e) {
    next(e);
  }
});

router.get('/my-bets', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const bets = await prisma.bet.findMany({
      where: { userId: req.userId },
      select: {
        id: true, panelSlot: true, betAmount: true, autoCashout: true,
        cashedOut: true, cashoutMultiplier: true, winAmount: true,
        placedAt: true, cashedOutAt: true,
        round: { select: { id: true, crashPointReal: true, status: true, createdAt: true } },
      },
      orderBy: { placedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    res.json(bets);
  } catch (e) {
    next(e);
  }
});

router.get('/live-bets', async (req, res, next) => {
  try {
    const round = await prisma.round.findFirst({
      where: { status: { in: ['WAITING', 'FLYING'] } },
      orderBy: { id: 'desc' },
    });
    if (!round) return res.json([]);

    const bets = await prisma.bet.findMany({
      where: { roundId: round.id },
      select: {
        panelSlot: true, betAmount: true, cashedOut: true,
        cashoutMultiplier: true, winAmount: true,
        user: { select: { username: true } },
      },
      orderBy: { placedAt: 'desc' },
    });

    res.json(bets.map(b => ({
      ...b,
      user: { username: maskUsername(b.user.username) },
    })));
  } catch (e) {
    next(e);
  }
});

router.get('/top-wins', async (req, res, next) => {
  try {
    const type = (req.query.type as string) || 'huge';
    const period = (req.query.period as string) || 'day';

    const now = new Date();
    let since: Date;
    if (period === 'day') since = new Date(now.getTime() - 86400000);
    else if (period === 'month') since = new Date(now.getFullYear(), now.getMonth(), 1);
    else since = new Date(now.getFullYear(), 0, 1);

    let orderBy: any = { winAmount: 'desc' };
    if (type === 'coefficients') orderBy = { cashoutMultiplier: 'desc' };

    const wins = await prisma.bet.findMany({
      where: {
        cashedOut: true,
        winAmount: { gt: 0 },
        cashedOutAt: { gte: since },
      },
      select: {
        betAmount: true, winAmount: true, cashoutMultiplier: true,
        user: { select: { username: true } },
        round: { select: { id: true } },
      },
      orderBy,
      take: 50,
    });

    res.json(wins.map(w => ({
      username: maskUsername(w.user.username),
      betAmount: w.betAmount,
      winAmount: w.winAmount,
      multiplier: w.cashoutMultiplier,
      roundId: w.round.id,
    })));
  } catch (e) {
    next(e);
  }
});

router.get('/multiplier-history', async (_req, res, next) => {
  try {
    const rounds = await prisma.round.findMany({
      where: { status: 'CRASHED' },
      select: { id: true, crashPointReal: true },
      orderBy: { id: 'desc' },
      take: 20,
    });
    res.json(rounds.reverse());
  } catch (e) {
    next(e);
  }
});

export default router;
