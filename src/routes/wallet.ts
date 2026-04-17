import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { walletLimiter } from '../middleware/rateLimit';
import { upload } from '../middleware/upload';
import { AppError, ErrorCodes } from '../utils/errors';

const router = Router();

const depositInitSchema = z.object({
  amount: z.number().int().min(10000),
  method: z.enum(['CLICK', 'PAYME', 'PAYNET', 'HUMO', 'UZCARD']),
  promoCode: z.string().optional(),
});

const withdrawSchema = z.object({
  amount: z.number().int().min(50000),
  method: z.enum(['CLICK', 'PAYME', 'PAYNET', 'HUMO', 'UZCARD']),
  cardNumber: z.string().regex(/^\d{16}$/, 'Card number must be 16 digits'),
  cardHolder: z.string().min(2).max(100),
});

router.get('/balance', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { balance: true, bonusBalance: true },
    });
    res.json(user);
  } catch (e) {
    next(e);
  }
});

router.post('/deposit/init', authMiddleware, walletLimiter, validate(depositInitSchema), async (req: AuthRequest, res, next) => {
  try {
    const { amount, method, promoCode } = req.body;

    // Select all active P2P cards for method, filter by daily limit in-memory (BigInt safe)
    const cards = await prisma.p2PCard.findMany({
      where: { method, isActive: true },
    });

    const available = cards.filter(c => c.usedToday < c.dailyLimit);
    if (available.length === 0) {
      return res.status(503).json({
        code: 'NO_CARD_AVAILABLE',
        message: 'Muvaqqat ishlamayapti. Qo\'llab-quvvatlash bilan bog\'laning.',
      });
    }

    const card = available[Math.floor(Math.random() * available.length)];

    const tx = await prisma.transaction.create({
      data: {
        userId: req.userId!,
        type: 'DEPOSIT',
        amount: BigInt(amount),
        method,
        status: 'PENDING',
        cardId: card.id,
        promoCode: promoCode || null,
      },
      select: { id: true, amount: true, method: true, status: true, createdAt: true },
    });

    // Update card usage
    await prisma.p2PCard.update({
      where: { id: card.id },
      data: { usedToday: { increment: BigInt(amount) } },
    });

    res.json({
      transactionId: tx.id,
      amount,
      card: { cardNumber: card.cardNumber, ownerName: card.ownerName, method: card.method },
    });
  } catch (e) {
    next(e);
  }
});

router.post('/deposit/cheque/:transactionId', authMiddleware, upload.single('cheque'), async (req: AuthRequest, res, next) => {
  try {
    const txId = parseInt(req.params.transactionId);
    const tx = await prisma.transaction.findFirst({
      where: { id: txId, userId: req.userId, type: 'DEPOSIT', status: 'PENDING' },
    });
    if (!tx) throw new AppError(ErrorCodes.TRANSACTION_NOT_FOUND, 404);
    if (!req.file) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'No file uploaded' });

    await prisma.transaction.update({
      where: { id: txId },
      data: { chequeFile: req.file.filename },
    });

    res.json({ status: 'PENDING', message: 'Cheque uploaded, awaiting admin approval' });
  } catch (e) {
    next(e);
  }
});

router.post('/withdraw', authMiddleware, walletLimiter, validate(withdrawSchema), async (req: AuthRequest, res, next) => {
  try {
    const { amount, method, cardNumber, cardHolder } = req.body;
    const bigAmount = BigInt(amount);

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { balance: true, bonusBalance: true, accountType: true },
    });
    if (!user) throw new AppError(ErrorCodes.USER_NOT_FOUND, 404);
    if (user.balance < bigAmount) throw new AppError(ErrorCodes.INSUFFICIENT_BALANCE, 400);

    // Demo accounts: create withdrawal record but do NOT deduct balance
    // Real accounts: deduct immediately, refund on admin reject
    const isDemo = user.accountType === 'DEMO';

    if (isDemo) {
      const tx = await prisma.transaction.create({
        data: { userId: req.userId!, type: 'WITHDRAWAL', amount: bigAmount, method, status: 'PENDING', cardNumber, cardHolder },
        select: { id: true, amount: true, status: true, createdAt: true },
      });
      return res.json({ transactionId: tx.id, status: 'PENDING', amount });
    }

    const tx = await prisma.$transaction([
      prisma.transaction.create({
        data: { userId: req.userId!, type: 'WITHDRAWAL', amount: bigAmount, method, status: 'PENDING', cardNumber, cardHolder },
        select: { id: true, amount: true, status: true, createdAt: true },
      }),
      prisma.user.update({
        where: { id: req.userId },
        data: { balance: { decrement: bigAmount } },
      }),
    ]);

    res.json({ transactionId: tx[0].id, status: 'PENDING', amount });
  } catch (e) {
    next(e);
  }
});

router.get('/transactions', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const type = req.query.type as string | undefined;

    const where: any = { userId: req.userId };
    if (type === 'deposit') where.type = 'DEPOSIT';
    if (type === 'withdrawal') where.type = 'WITHDRAWAL';

    const [items, total] = await prisma.$transaction([
      prisma.transaction.findMany({
        where,
        select: {
          id: true, type: true, amount: true, method: true,
          status: true, createdAt: true, processedAt: true,
          promoCode: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.transaction.count({ where }),
    ]);

    res.json({ items, total, page, limit });
  } catch (e) {
    next(e);
  }
});

router.get('/bonus-grants', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const grants = await prisma.bonusGrant.findMany({
      where: { userId: req.userId, isConverted: false },
      select: {
        id: true, type: true, bonusAmount: true,
        wageringRequired: true, wageringProgress: true,
        expiresAt: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(grants);
  } catch (e) {
    next(e);
  }
});

export default router;
