import { Router }                         from 'express';
import { z }                              from 'zod';
import * as svc                           from './deposit.service';
import { requireAuthAndNotBanned }        from '../../middleware/auth';
import { asyncHandler, safeParseInt, AppError } from '../../utils/helpers';

const router = Router();
router.use(requireAuthAndNotBanned);

// Max file size: 20MB as base64 (~27MB string)
const MAX_FILE_B64_LEN = 27 * 1024 * 1024;

const ALLOWED_TYPES = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/bmp',
  'image/gif', 'image/webp', 'application/pdf',
];

const createSchema = z.object({
  amount:        z.number().positive(),
  paymentMethod: z.enum(['humo', 'uzcard']),
  chequeFile:    z.string().min(10),      // base64 data URI: "data:image/jpeg;base64,..."
  chequeFileName:z.string().min(1).max(255),
  promoCode:     z.string().optional(),
});

router.post('/', asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);

  // Validate file size
  if (body.chequeFile.length > MAX_FILE_B64_LEN) {
    throw new AppError(400, 'File too large. Maximum 20MB.');
  }

  // Validate file type from data URI
  const mimeMatch = body.chequeFile.match(/^data:([^;]+);base64,/);
  if (!mimeMatch) {
    throw new AppError(400, 'Invalid file format. Must be a base64 data URI.');
  }
  if (!ALLOWED_TYPES.includes(mimeMatch[1])) {
    throw new AppError(400, 'Unsupported file type. Allowed: JPG, PNG, BMP, PDF, GIF, WEBP');
  }

  const result = await svc.createDeposit(
    req.user!.id,
    body.amount,
    body.paymentMethod,
    body.chequeFile,
    body.chequeFileName,
    body.promoCode,
    req.user!.lang
  );
  res.status(201).json(result);
}));

router.get('/', asyncHandler(async (req, res) => {
  const page  = safeParseInt(req.query.page,  1);
  const limit = safeParseInt(req.query.limit, 20);
  res.json(await svc.getUserDeposits(req.user!.id, page, limit));
}));

// Get cheque file for a specific deposit (admin or owner only)
router.get('/:id/file', asyncHandler(async (req, res) => {
  const { rows } = await (await import('../../db/pool')).pool.query(
    'SELECT cheque_file, cheque_ref FROM deposits WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user!.id]
  );
  if (!rows[0] || !rows[0].cheque_file) {
    throw new AppError(404, 'File not found');
  }
  res.json({ file: rows[0].cheque_file, filename: rows[0].cheque_ref });
}));

export default router;
