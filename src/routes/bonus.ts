import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { AppError, ErrorCodes } from '../utils/errors';

const router = Router();

const applySchema = z.object({ code: z.string().min(1).max(50) });

router.post('/apply', authMiddleware, validate(applySchema), async (req: AuthRequest, res, next) => {
  try {
    const { code } = req.body;

    const promo = await prisma.promoCode.findUnique({ where: { code } });
    if (!promo) throw new AppError(ErrorCodes.PROMO_NOT_FOUND, 404);
    if (!promo.isActive) throw new AppError(ErrorCodes.PROMO_INACTIVE, 400);
    if (promo.expiresAt && promo.expiresAt < new Date()) throw new AppError(ErrorCodes.PROMO_EXPIRED, 400);
    if (promo.maxUsage && promo.usageCount >= promo.maxUsage) throw new AppError(ErrorCodes.PROMO_MAX_USAGE, 400);

    // FIXED_CREDIT: can be applied directly without deposit
    if (promo.type === 'FIXED_CREDIT') {
      const bonusAmount = BigInt(Math.round(promo.value));
      const wageringRequired = BigInt(Math.round(Number(bonusAmount) * promo.wageringMultiplier));

      await prisma.$transaction([
        prisma.bonusGrant.create({
          data: {
            userId: req.userId!,
            promoCodeId: promo.id,
            type: 'FIXED_CREDIT',
            bonusAmount,
            wageringRequired,
          },
        }),
        prisma.user.update({
          where: { id: req.userId },
          data: { bonusBalance: { increment: bonusAmount } },
        }),
        prisma.promoCode.update({ where: { id: promo.id }, data: { usageCount: { increment: 1 } } }),
      ]);

      return res.json({ type: 'FIXED_CREDIT', bonusAmount: bonusAmount.toString(), wageringMultiplier: promo.wageringMultiplier });
    }

    // DEPOSIT_MATCH: return promo info, applied at deposit approval time
    if (promo.type === 'DEPOSIT_MATCH') {
      return res.json({
        type: 'DEPOSIT_MATCH',
        matchPct: promo.value,
        maxBonusUZS: promo.maxBonusUZS,
        wageringMultiplier: promo.wageringMultiplier,
        promoId: promo.id,
      });
    }

    res.json({ type: promo.type });
  } catch (e) {
    next(e);
  }
});

router.get('/validate/:code', async (req, res, next) => {
  try {
    const promo = await prisma.promoCode.findUnique({
      where: { code: req.params.code },
      select: { type: true, value: true, isActive: true, expiresAt: true, maxBonusUZS: true, wageringMultiplier: true },
    });
    if (!promo || !promo.isActive) throw new AppError(ErrorCodes.PROMO_NOT_FOUND, 404);
    if (promo.expiresAt && promo.expiresAt < new Date()) throw new AppError(ErrorCodes.PROMO_EXPIRED, 400);
    res.json(promo);
  } catch (e) {
    next(e);
  }
});

export default router;

// Apply referral code - transfers referral ownership to new referrer
router.post('/referral', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const { code } = z.object({ code: z.string().min(1) }).parse(req.body);

    // Find referrer by their referral code
    const referrer = await prisma.user.findUnique({
      where: { referralCode: code },
      select: { id: true, username: true },
    });
    if (!referrer) throw new AppError(ErrorCodes.NOT_FOUND, 404);
    if (referrer.id === req.userId) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Cannot use your own referral code' });
    }

    // Transfer referral ownership to new referrer
    await prisma.user.update({
      where: { id: req.userId },
      data: { referredById: referrer.id },
    });

    res.json({ success: true, referredBy: referrer.id });
  } catch (e) {
    next(e);
  }
});
