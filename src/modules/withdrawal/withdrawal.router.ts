import { Router } from 'express';
import { z } from 'zod';
import * as withdrawalService from './withdrawal.service';
import { requireAuthAndNotBanned } from '../../middleware/auth';
import { asyncHandler, safeParseInt } from '../../utils/helpers';
import { PAYMENT_METHODS } from '../../config/constants';

const router = Router();
router.use(requireAuthAndNotBanned);

router.post('/', asyncHandler(async (req, res) => {
  const schema = z.object({
    amount: z.number().positive(),
    paymentMethod: z.enum(PAYMENT_METHODS),
    cardNumber: z.string().min(16).max(20),
  });
  const { amount, paymentMethod, cardNumber } = schema.parse(req.body);
  const result = await withdrawalService.createWithdrawal(
    req.user!.id, amount, paymentMethod, cardNumber, req.user!.lang
  );
  res.status(201).json(result);
}));

router.get('/', asyncHandler(async (req, res) => {
  const result = await withdrawalService.getUserWithdrawals(
    req.user!.id,
    safeParseInt(req.query.page, 1),
    safeParseInt(req.query.limit, 20)
  );
  res.json(result);
}));

export default router;
