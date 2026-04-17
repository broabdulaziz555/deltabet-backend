import rateLimit from 'express-rate-limit';

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { code: 'RATE_LIMIT', message: 'Too many attempts, try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const betLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req: any) => `bet:${req.userId || req.ip}`,
  message: { code: 'RATE_LIMIT', message: 'Too many bets' },
});

export const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req: any) => `chat:${req.userId || req.ip}`,
  message: { code: 'RATE_LIMIT', message: 'Slow down' },
});

export const walletLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req: any) => `wallet:${req.userId || req.ip}`,
  message: { code: 'RATE_LIMIT', message: 'Too many wallet requests' },
});

export const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { code: 'RATE_LIMIT', message: 'Admin rate limit exceeded' },
});

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { code: 'RATE_LIMIT', message: 'Too many requests' },
});
