import { Router }             from 'express';
import { z }                  from 'zod';
import * as promoService      from './promo.service';
import { requireAuthAndNotBanned } from '../../middleware/auth';
import { asyncHandler }       from '../../utils/helpers';

const router = Router();
router.use(requireAuthAndNotBanned);

router.post('/validate', asyncHandler(async (req, res) => {
  const { code, depositAmount } = z.object({
    code:          z.string().min(1),
    depositAmount: z.number().positive(),
  }).parse(req.body);
  res.json(await promoService.validatePromoPreview(code, depositAmount, req.user!.lang));
}));

export default router;
