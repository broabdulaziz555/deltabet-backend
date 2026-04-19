import { Router, Request, Response } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { requireAdmin } from '../../middleware/adminAuth';
import { asyncHandler, safeParseInt } from '../../utils/helpers';
import { pool } from '../../db/pool';
import * as adminService from './admin.service';

const router = Router();

// ── Admin login ────────────────────────────────────────────────────────────
router.post('/login', asyncHandler(async (req: Request, res: Response) => {
  const { username, password } = z.object({
    username: z.string(),
    password: z.string(),
  }).parse(req.body);

  const usernameOk = username === env.ADMIN_USERNAME;
  // Compare password — supports both plaintext (dev) and bcrypt hash in env
  let passwordOk = false;
  if (env.ADMIN_PASSWORD.startsWith('$2')) {
    // bcrypt hash in env
    const { default: bcrypt } = await import('bcrypt');
    passwordOk = await bcrypt.compare(password, env.ADMIN_PASSWORD);
  } else {
    // plaintext (acceptable for self-hosted MVP, warn in logs)
    passwordOk = password === env.ADMIN_PASSWORD;
  }

  if (!usernameOk || !passwordOk) {
    res.status(401).json({ error: 'Invalid admin credentials' });
    return;
  }
  const token = jwt.sign({ username, role: 'admin' }, env.ADMIN_JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
}));

// All routes below require admin JWT
router.use(requireAdmin);

// ── Users ──────────────────────────────────────────────────────────────────
router.get('/users', asyncHandler(async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const page   = safeParseInt(req.query.page,  1);
  const limit  = safeParseInt(req.query.limit, 20);
  res.json(await adminService.getUsers(search, page, limit));
}));

router.get('/users/:id', asyncHandler(async (req, res) => {
  res.json(await adminService.getUser(req.params.id));
}));

router.patch('/users/:id/account-type', asyncHandler(async (req, res) => {
  const { accountType } = z.object({ accountType: z.enum(['real', 'demo']) }).parse(req.body);
  res.json(await adminService.setAccountType(req.params.id, accountType, req.admin!.username));
}));

router.patch('/users/:id/ban', asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(1).max(500) }).parse(req.body);
  res.json(await adminService.banUser(req.params.id, reason, req.admin!.username));
}));

router.patch('/users/:id/unban', asyncHandler(async (req, res) => {
  res.json(await adminService.unbanUser(req.params.id, req.admin!.username));
}));

router.patch('/users/:id/balance', asyncHandler(async (req, res) => {
  const body = z.object({
    type:   z.enum(['add', 'deduct']),
    amount: z.number().positive(),
    note:   z.string().default(''),
  }).parse(req.body);
  res.json(await adminService.adjustBalance(
    req.params.id, body.type, body.amount, body.note, req.admin!.username
  ));
}));

router.get('/users/:id/ledger', asyncHandler(async (req, res) => {
  res.json(await adminService.getUserLedger(
    req.params.id, safeParseInt(req.query.page, 1), safeParseInt(req.query.limit, 20)
  ));
}));

// Currently online users (those with active WS connections)
router.get('/users/online', asyncHandler(async (req, res) => {
  const { getOnlineUserCount } = await import('../../ws/wsServer');
  res.json({ onlineCount: getOnlineUserCount() });
}));

router.get('/users/:id/bets', asyncHandler(async (req, res) => {
  res.json(await adminService.getUserBets(
    req.params.id, safeParseInt(req.query.page, 1), safeParseInt(req.query.limit, 20)
  ));
}));

// ── Deposits ───────────────────────────────────────────────────────────────
router.get('/deposits', asyncHandler(async (req, res) => {
  const str = (k: string) => typeof req.query[k] === 'string' ? req.query[k] as string : undefined;
  res.json(await adminService.adminGetDeposits(
    safeParseInt(req.query.page, 1),
    safeParseInt(req.query.limit, 20),
    str('status'),
    str('userId'),
    str('chequeRef'),
    str('from'),
    str('to')
  ));
}));

router.get('/deposits/:id', asyncHandler(async (req, res) => {
  res.json(await adminService.adminGetDeposit(req.params.id));
}));

router.get('/deposits/:id/file', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT cheque_file, cheque_ref FROM deposits WHERE id = $1',
    [req.params.id]
  );
  if (!rows[0] || !rows[0].cheque_file) {
    res.status(404).json({ error: 'File not found' }); return;
  }
  res.json({ file: rows[0].cheque_file, filename: rows[0].cheque_ref });
}));

router.patch('/deposits/:id/approve', asyncHandler(async (req, res) => {
  const { amountActual } = z.object({ amountActual: z.number().positive() }).parse(req.body);
  res.json(await adminService.adminApproveDeposit(req.params.id, amountActual, req.admin!.username));
}));

router.patch('/deposits/:id/reject', asyncHandler(async (req, res) => {
  const { note } = z.object({ note: z.string().default('') }).parse(req.body);
  res.json(await adminService.adminRejectDeposit(req.params.id, note, req.admin!.username));
}));

// ── Withdrawals ────────────────────────────────────────────────────────────
router.get('/withdrawals', asyncHandler(async (req, res) => {
  const str = (k: string) => typeof req.query[k] === 'string' ? req.query[k] as string : undefined;
  res.json(await adminService.adminGetWithdrawals(
    safeParseInt(req.query.page, 1),
    safeParseInt(req.query.limit, 20),
    str('status'),
    str('from'),
    str('to')
  ));
}));

router.patch('/withdrawals/:id/approve', asyncHandler(async (req, res) => {
  res.json(await adminService.adminApproveWithdrawal(req.params.id, req.admin!.username));
}));

router.patch('/withdrawals/:id/reject', asyncHandler(async (req, res) => {
  const { note } = z.object({ note: z.string().default('') }).parse(req.body);
  res.json(await adminService.adminRejectWithdrawal(req.params.id, note, req.admin!.username));
}));

// ── Promos ─────────────────────────────────────────────────────────────────

// List all promos — supports ?search=CODE&isActive=true&page=1&limit=20
router.get('/promos', asyncHandler(async (req, res) => {
  const isActiveRaw = req.query.isActive;
  const isActive = isActiveRaw === 'true' ? true : isActiveRaw === 'false' ? false : undefined;
  res.json(await adminService.adminListPromos({
    page:     safeParseInt(req.query.page,  1),
    limit:    safeParseInt(req.query.limit, 20),
    search:   typeof req.query.search === 'string' ? req.query.search : undefined,
    isActive,
  }));
}));

// Get single promo with tiers + usage stats
router.get('/promos/:id', asyncHandler(async (req, res) => {
  res.json(await adminService.adminGetPromo(req.params.id));
}));

// Create promo — tiers optional, can add later
router.post('/promos', asyncHandler(async (req, res) => {
  const body = z.object({
    code:        z.string().min(1).max(50),
    description: z.string().default(''),
    maxUses:     z.number().int().positive().nullable().default(null),
    expiresAt:   z.string().datetime({ offset: true }).nullable().default(null),
    isActive:    z.boolean().default(true),
    tiers:       z.array(z.object({
      minDeposit: z.number().positive(),
      bonusType:  z.enum(['percent', 'fixed']),
      bonusValue: z.number().positive(),
    })).default([]),
  }).parse(req.body);

  res.status(201).json(await adminService.adminCreatePromo(body));
}));

// Update promo fields (description, isActive, maxUses, expiresAt)
router.patch('/promos/:id', asyncHandler(async (req, res) => {
  const body = z.object({
    description: z.string().optional(),
    isActive:    z.boolean().optional(),
    maxUses:     z.number().int().positive().nullable().optional(),
    expiresAt:   z.string().datetime({ offset: true }).nullable().optional(),
  }).parse(req.body);

  res.json(await adminService.adminUpdatePromo(req.params.id, body));
}));

// Toggle active/inactive — one click from UI
router.post('/promos/:id/toggle', asyncHandler(async (req, res) => {
  res.json(await adminService.adminTogglePromo(req.params.id));
}));

// Delete promo — hard delete if unused, soft deactivate if has usage history
router.delete('/promos/:id', asyncHandler(async (req, res) => {
  res.json(await adminService.adminDeletePromo(req.params.id));
}));

// ── Promo Tiers ────────────────────────────────────────────────────────────

// Add a tier — returns updated full promo
router.post('/promos/:id/tiers', asyncHandler(async (req, res) => {
  const body = z.object({
    minDeposit: z.number().positive(),
    bonusType:  z.enum(['percent', 'fixed']),
    bonusValue: z.number().positive(),
  }).parse(req.body);

  res.status(201).json(await adminService.adminAddTier(
    req.params.id, body.minDeposit, body.bonusType, body.bonusValue
  ));
}));

// Edit a tier — returns updated full promo
router.patch('/promos/:id/tiers/:tierId', asyncHandler(async (req, res) => {
  const body = z.object({
    minDeposit: z.number().positive().optional(),
    bonusType:  z.enum(['percent', 'fixed']).optional(),
    bonusValue: z.number().positive().optional(),
  }).parse(req.body);

  res.json(await adminService.adminUpdateTier(
    req.params.id, Number(req.params.tierId), body
  ));
}));

// Delete a tier — returns updated full promo
router.delete('/promos/:id/tiers/:tierId', asyncHandler(async (req, res) => {
  res.json(await adminService.adminDeleteTier(
    req.params.id, Number(req.params.tierId)
  ));
}));

// ── Stats ──────────────────────────────────────────────────────────────────
router.get('/stats/overview', asyncHandler(async (req, res) => {
  res.json(await adminService.getOverviewStats());
}));

router.get('/stats/revenue', asyncHandler(async (req, res) => {
  const from = typeof req.query.from === 'string'
    ? req.query.from
    : new Date(Date.now() - 30 * 86_400_000).toISOString();
  const to = typeof req.query.to === 'string'
    ? req.query.to
    : new Date().toISOString();
  res.json(await adminService.getRevenue(from, to));
}));

router.get('/stats/users/top', asyncHandler(async (req, res) => {
  res.json(await adminService.getTopUsers());
}));

router.get('/stats/rounds', asyncHandler(async (req, res) => {
  const tableId = typeof req.query.tableId === 'string' ? Number(req.query.tableId) : undefined;
  const from    = typeof req.query.from    === 'string' ? req.query.from    : undefined;
  const to      = typeof req.query.to      === 'string' ? req.query.to      : undefined;
  res.json(await adminService.getRounds(
    tableId, from, to,
    safeParseInt(req.query.page,  1),
    safeParseInt(req.query.limit, 50)
  ));
}));

router.get('/logs', asyncHandler(async (req, res) => {
  res.json(await adminService.getAdminLogs(
    safeParseInt(req.query.page,  1),
    safeParseInt(req.query.limit, 50)
  ));
}));

// ── Game control ───────────────────────────────────────────────────────────
router.get('/game/tables', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, status FROM game_tables ORDER BY id');
  res.json(rows);
}));

router.post('/game/tables/:id/pause', asyncHandler(async (req, res) => {
  res.json(await adminService.pauseTable(Number(req.params.id)));
}));

router.post('/game/tables/:id/resume', asyncHandler(async (req, res) => {
  res.json(await adminService.resumeTable(Number(req.params.id)));
}));

export default router;
