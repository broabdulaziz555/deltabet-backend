import { Router }                     from 'express';
import * as walletService             from './wallet.service';
import { requireAuthAndNotBanned }    from '../../middleware/auth';
import { asyncHandler, safeParseInt } from '../../utils/helpers';

const router = Router();
router.use(requireAuthAndNotBanned);

router.get('/', asyncHandler(async (req, res) => {
  res.json(await walletService.getWallet(req.user!.id));
}));

router.get('/history', asyncHandler(async (req, res) => {
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  res.json(await walletService.getLedger(
    req.user!.id,
    safeParseInt(req.query.page,  1),
    safeParseInt(req.query.limit, 20),
    type
  ));
}));

export default router;
