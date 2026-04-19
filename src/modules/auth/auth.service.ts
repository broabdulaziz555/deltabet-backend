import bcrypt    from 'bcrypt';
import jwt       from 'jsonwebtoken';
import crypto    from 'crypto';
import { pool }  from '../../db/pool';
import { env }   from '../../config/env';
import { LIMITS, LANGS } from '../../config/constants';
import { AppError }      from '../../utils/helpers';
import { t, Lang }       from '../i18n/translations';
import { logger }        from '../../utils/logger';

const SALT_ROUNDS = 10;

// ─── Username validation ──────────────────────────────────────────────────────

// Only allow letters (including Cyrillic), digits, underscore, hyphen
// Prevents XSS characters like < > ' " & in usernames
const USERNAME_RE = /^[\w\u0400-\u04FF-]{8,32}$/;

function validateUsername(username: string, lang: Lang): void {
  if (!USERNAME_RE.test(username)) {
    throw new AppError(400, lang === 'ru'
      ? 'Имя пользователя: 8–32 символа, только буквы, цифры, _ или -'
      : lang === 'uz'
      ? "Foydalanuvchi nomi: 8–32 belgi, faqat harflar, raqamlar, _ yoki -"
      : 'Username: 8–32 chars, only letters, digits, _ or -'
    );
  }
}

// ─── Token helpers ────────────────────────────────────────────────────────────

interface DbUser {
  id:           string;
  username:     string;
  lang:         string;
  account_type: string;
  balance?:     string;
  credit?:      string;
  is_banned?:   boolean;
  ban_reason?:  string;
  password_hash?: string;
}

function sanitizeUser(user: DbUser) {
  const { password_hash: _ph, account_type: _at, ...safe } = user;
  void _ph; void _at;
  return safe;
}

function toLang(raw: string): Lang {
  return (LANGS as readonly string[]).includes(raw) ? (raw as Lang) : 'ru';
}

function signTokens(user: { id: string; username: string; lang: string; account_type: string }) {
  const access = jwt.sign(
    { sub: user.id, username: user.username, lang: user.lang, account_type: user.account_type },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN }
  );
  const refresh = jwt.sign(
    { sub: user.id },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN }
  );
  return { accessToken: access, refreshToken: refresh };
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ─── Auth flows ───────────────────────────────────────────────────────────────

export async function register(username: string, password: string, lang: Lang = 'ru') {
  validateUsername(username, lang);
  if (password.length < LIMITS.PASSWORD_MIN || password.length > LIMITS.PASSWORD_MAX) {
    throw new AppError(400, `Password must be ${LIMITS.PASSWORD_MIN}–${LIMITS.PASSWORD_MAX} characters`);
  }

  const { rows: existing } = await pool.query(
    'SELECT id FROM users WHERE username = $1', [username]
  );
  if (existing.length > 0) throw new AppError(409, t('usernameExists', lang));

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const { rows } = await pool.query(
    `INSERT INTO users (username, password_hash, lang)
     VALUES ($1, $2, $3)
     RETURNING id, username, lang, account_type, balance, credit`,
    [username, passwordHash, lang]
  );

  logger.info('User registered', { userId: rows[0].id, username });
  const user = rows[0] as DbUser;
  return { user: sanitizeUser(user), ...signTokens(user) };
}

export async function login(username: string, password: string) {
  const { rows } = await pool.query(
    `SELECT id, username, password_hash, lang, account_type,
            is_banned, ban_reason, balance, credit
     FROM users WHERE username = $1`,
    [username]
  );
  const user = rows[0] as DbUser | undefined;

  // Timing-safe: always run bcrypt even if user not found
  const fakeHash = '$2b$10$invalidhashfortimingsafety000000000000000000000000000';
  const valid    = await bcrypt.compare(password, user?.password_hash ?? fakeHash);

  if (!user || !valid) {
    logger.warn('Failed login attempt', { username });
    throw new AppError(401, t('invalidCredentials', user ? toLang(user.lang) : 'ru'));
  }
  if (user.is_banned) throw new AppError(403, t('userBanned', toLang(user.lang)), 'BANNED');

  logger.info('User logged in', { userId: user.id, username });
  return { user: sanitizeUser(user), ...signTokens(user) };
}

export async function getProfile(userId: string) {
  const { rows } = await pool.query(
    `SELECT id, username, lang, balance, credit, created_at FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows[0]) throw new AppError(404, 'User not found');
  return rows[0];
}

export async function getUserStats(userId: string) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)                                    AS total_bets,
       COUNT(*) FILTER (WHERE status = 'won')      AS bets_won,
       COUNT(*) FILTER (WHERE status = 'lost')     AS bets_lost,
       COALESCE(SUM(amount), 0)                    AS total_wagered,
       COALESCE(SUM(payout), 0)                    AS total_won,
       COALESCE(MAX(cashout_at), 0)                AS biggest_multiplier,
       COALESCE(MAX(payout), 0)                    AS biggest_payout,
       COALESCE(SUM(payout) - SUM(amount), 0)      AS net_profit
     FROM bets
     WHERE user_id = $1 AND status != 'active'`,
    [userId]
  );
  return rows[0];
}

export async function refresh(refreshToken: string) {
  // Check blacklist first
  const tokenHash = hashToken(refreshToken);
  const { rows: bl } = await pool.query(
    'SELECT 1 FROM refresh_token_blacklist WHERE token_hash = $1',
    [tokenHash]
  );
  if (bl.length > 0) throw new AppError(401, 'Token has been revoked');

  try {
    const payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as { sub: string };
    const { rows } = await pool.query(
      'SELECT id, username, lang, account_type, is_banned FROM users WHERE id = $1',
      [payload.sub]
    );
    if (!rows[0] || rows[0].is_banned) throw new AppError(401, 'Invalid session');
    return signTokens(rows[0] as DbUser);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(401, 'Invalid refresh token');
  }
}

export async function logout(refreshToken: string, userId: string) {
  const tokenHash = hashToken(refreshToken);
  // Decode expiry without verifying (it may already be expired)
  let expiresAt: Date;
  try {
    const decoded = jwt.decode(refreshToken) as { exp?: number } | null;
    expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 30 * 86_400_000);
  } catch {
    expiresAt = new Date(Date.now() + 30 * 86_400_000);
  }

  await pool.query(
    `INSERT INTO refresh_token_blacklist (token_hash, user_id, expires_at)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [tokenHash, userId, expiresAt]
  );

  // Clean up expired entries opportunistically
  pool.query(
    'DELETE FROM refresh_token_blacklist WHERE expires_at < now()'
  ).catch(() => {});

  return { loggedOut: true };
}

export async function changeCredentials(
  userId:          string,
  currentPassword: string,
  newUsername?:    string,
  newPassword?:    string
) {
  const { rows } = await pool.query(
    'SELECT password_hash, lang FROM users WHERE id = $1', [userId]
  );
  if (!rows[0]) throw new AppError(404, 'User not found');

  const lang  = toLang(rows[0].lang);
  const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!valid) throw new AppError(401, t('invalidCredentials', lang));

  if (newUsername) {
    validateUsername(newUsername, lang);
    const { rows: taken } = await pool.query(
      'SELECT id FROM users WHERE username = $1 AND id != $2', [newUsername, userId]
    );
    if (taken.length > 0) throw new AppError(409, t('usernameExists', lang));
    await pool.query(
      'UPDATE users SET username = $1, updated_at = now() WHERE id = $2',
      [newUsername, userId]
    );
  }

  if (newPassword) {
    if (newPassword.length < LIMITS.PASSWORD_MIN || newPassword.length > LIMITS.PASSWORD_MAX) {
      throw new AppError(400, `Password must be ${LIMITS.PASSWORD_MIN}–${LIMITS.PASSWORD_MAX} characters`);
    }
    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
      [hash, userId]
    );
  }

  logger.info('User credentials changed', { userId });
  return { success: true };
}

export async function validateTelegramInitData(initData: string) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new AppError(503, 'Telegram not configured');

  const params = new URLSearchParams(initData);
  const hash   = params.get('hash');
  if (!hash) throw new AppError(400, 'Missing hash');

  params.delete('hash');
  const checkString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey    = crypto.createHmac('sha256', 'WebAppData').update(env.TELEGRAM_BOT_TOKEN).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(hash))) {
    throw new AppError(401, 'Invalid Telegram signature');
  }

  const userStr = params.get('user');
  if (!userStr) throw new AppError(400, 'No user data');
  const tgUser: { id: number; language_code?: string } = JSON.parse(userStr);
  const lang = toLang(tgUser.language_code ?? 'ru');

  const { rows } = await pool.query(
    'SELECT * FROM users WHERE telegram_id = $1', [tgUser.id]
  );
  if (rows[0]) {
    return { user: sanitizeUser(rows[0] as DbUser), ...signTokens(rows[0] as DbUser) };
  }

  const baseUsername = `tg_${tgUser.id}`;
  const passwordHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), SALT_ROUNDS);

  const { rows: newRows } = await pool.query(
    `INSERT INTO users (username, password_hash, lang, telegram_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (username) DO UPDATE SET telegram_id = EXCLUDED.telegram_id
     RETURNING id, username, lang, account_type, balance, credit`,
    [baseUsername, passwordHash, lang, tgUser.id]
  );

  logger.info('Telegram user auto-created', { userId: newRows[0].id, telegramId: tgUser.id });
  return { user: sanitizeUser(newRows[0] as DbUser), ...signTokens(newRows[0] as DbUser) };
}
