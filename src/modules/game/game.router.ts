import { Router }                     from 'express';
import { z }                          from 'zod';
import * as gameService               from './game.service';
import { requireAuthAndNotBanned }    from '../../middleware/auth';
import { asyncHandler, safeParseInt } from '../../utils/helpers';
import { CURRENCY }                   from '../../config/constants';

const router = Router();

// ── Public routes (no auth) ───────────────────────────────────────────────
// Provably fair verification — anyone can verify a round
router.get('/verify/:roundId', asyncHandler(async (req, res) => {
  res.json(await gameService.verifyRound(req.params.roundId));
}));

// ── Auth required ─────────────────────────────────────────────────────────
router.use(requireAuthAndNotBanned);

router.get('/tables', asyncHandler(async (_req, res) => {
  res.json(await gameService.getTables());
}));

router.get('/tables/:id/history', asyncHandler(async (req, res) => {
  res.json(await gameService.getTableHistory(
    Number(req.params.id), safeParseInt(req.query.limit, 50)
  ));
}));

router.get('/tables/:id/bets', asyncHandler(async (req, res) => {
  res.json(await gameService.getTableLiveBets(Number(req.params.id)));
}));

router.get('/rounds/:id', asyncHandler(async (req, res) => {
  res.json(await gameService.getRound(req.params.id));
}));

router.post('/bet', asyncHandler(async (req, res) => {
  const body = z.object({
    tableId:       z.number().int().positive(),
    amount:        z.number().positive(),
    panel:         z.union([z.literal(0), z.literal(1)]).default(0),
    autoCashoutAt: z.number().min(1.01).nullable().default(null),
    // currencyType kept for API compat but backend auto-deducts balance first
    currencyType:  z.enum([CURRENCY.BALANCE, CURRENCY.CREDIT]).default(CURRENCY.BALANCE),
  }).parse(req.body);

  const result = await gameService.placeBetHttp(
    req.user!.id, req.user!.username,
    body.tableId, body.amount, body.currencyType,
    body.panel,
    req.user!.account_type === 'demo',
    body.autoCashoutAt,
    req.user!.lang
  );
  res.status(201).json(result);
}));

router.post('/cashout', asyncHandler(async (req, res) => {
  const body = z.object({
    tableId: z.number().int().positive(),
    betId:   z.string().uuid().optional(),
  }).parse(req.body);
  res.json(await gameService.cashoutHttp(
    req.user!.id, body.tableId, body.betId, req.user!.lang
  ));
}));

router.get('/my-bets', asyncHandler(async (req, res) => {
  res.json(await gameService.getMyBets(
    req.user!.id,
    safeParseInt(req.query.page,  1),
    safeParseInt(req.query.limit, 20)
  ));
}));

// Active bets for reconnection state recovery — MUST be before export default
router.get('/my-active-bets', asyncHandler(async (req, res) => {
  res.json(await gameService.getMyActiveBets(req.user!.id));
}));

export default router;
