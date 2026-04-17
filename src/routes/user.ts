import { Router } from 'express';
import { prisma } from '../config/database';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { AppError, ErrorCodes } from '../utils/errors';

const router = Router();

router.get('/profile', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true, username: true, accountType: true, balance: true,
        bonusBalance: true, referralCode: true, lang: true,
        createdAt: true, lastSeenAt: true,
        _count: { select: { bets: true, referrals: true } },
      },
    });
    if (!user) throw new AppError(ErrorCodes.USER_NOT_FOUND, 404);

    await prisma.user.update({ where: { id: req.userId }, data: { lastSeenAt: new Date() } });
    res.json(user);
  } catch (e) {
    next(e);
  }
});

router.get('/referrals', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);

    const [referrals, earnings] = await prisma.$transaction([
      prisma.user.findMany({
        where: { referredById: req.userId },
        select: { id: true, username: true, createdAt: true, lastSeenAt: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.referralEarning.aggregate({
        where: { referrerId: req.userId },
        _sum: { commission: true },
        _count: true,
      }),
    ]);

    res.json({
      referrals: referrals.map(r => ({
        ...r,
        username: r.username.slice(0, 2) + '***',
      })),
      totalEarnings: earnings._sum.commission || 0n,
      totalReferrals: earnings._count,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
