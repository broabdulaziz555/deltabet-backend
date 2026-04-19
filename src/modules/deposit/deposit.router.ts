import { Router } from 'express';
import { z } from 'zod';
import * as svc from './deposit.service';
import { requireAuthAndNotBanned } from '../../middleware/auth';
import { asyncHandler, safeParseInt } from '../../utils/helpers';

const router = Router();
router.use(requireAuthAndNotBanned);

const createSchema = z.object({
  amount: z.number().positive(),
  paymentMethod: z.enum(['humo', 'uzcard']),
  chequeRef: z.string().min(1),
  promoCode: z.string().optional(),
});

router.post('/', asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  const result = await svc.createDeposit(
    req.user!.id, body.amount, body.paymentMethod,
    body.chequeRef, body.promoCode, req.user!.lang
  );
  res.status(201).json(result);
}));

router.get('/', asyncHandler(async (req, res) => {
  const page = safeParseInt(req.query.page, 1);
  const limit = safeParseInt(req.query.limit, 20);
  res.json(await svc.getUserDeposits(req.user!.id, page, limit));
}));

export default router;
