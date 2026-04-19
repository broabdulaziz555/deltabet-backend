import { Router }        from 'express';
import { z }             from 'zod';
import * as authService  from './auth.service';
import { requireAuth }   from '../../middleware/auth';
import { asyncHandler }  from '../../utils/helpers';

const router = Router();

router.post('/register', asyncHandler(async (req, res) => {
  const body = z.object({
    username: z.string().min(8).max(32),
    password: z.string().min(8).max(32),
    lang:     z.enum(['ru', 'uz', 'en']).default('ru'),
  }).parse(req.body);
  res.status(201).json(await authService.register(body.username, body.password, body.lang));
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = z.object({
    username: z.string(),
    password: z.string(),
  }).parse(req.body);
  res.json(await authService.login(username, password));
}));

router.post('/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
  res.json(await authService.refresh(refreshToken));
}));

// Logout — blacklists the refresh token
router.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
  res.json(await authService.logout(refreshToken, req.user!.id));
}));

// Current user profile + wallet
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  res.json(await authService.getProfile(req.user!.id));
}));

// Current user game stats
router.get('/me/stats', requireAuth, asyncHandler(async (req, res) => {
  res.json(await authService.getUserStats(req.user!.id));
}));

router.put('/change-credentials', requireAuth, asyncHandler(async (req, res) => {
  const body = z.object({
    currentPassword: z.string(),
    newUsername:     z.string().min(8).max(32).optional(),
    newPassword:     z.string().min(8).max(32).optional(),
  }).parse(req.body);

  if (!body.newUsername && !body.newPassword) {
    res.status(400).json({ error: 'Provide at least newUsername or newPassword' });
    return;
  }
  res.json(await authService.changeCredentials(
    req.user!.id, body.currentPassword, body.newUsername, body.newPassword
  ));
}));

router.post('/telegram', asyncHandler(async (req, res) => {
  const { initData } = z.object({ initData: z.string() }).parse(req.body);
  res.json(await authService.validateTelegramInitData(initData));
}));

export default router;
