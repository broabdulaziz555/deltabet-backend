import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const env = {
  PORT: parseInt(optional('PORT', '3000')),
  NODE_ENV: optional('NODE_ENV', 'development'),
  DATABASE_URL: required('DATABASE_URL'),

  JWT_SECRET: required('JWT_SECRET'),
  JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET'),
  JWT_EXPIRES_IN: optional('JWT_EXPIRES_IN', '24h'),
  JWT_REFRESH_EXPIRES_IN: optional('JWT_REFRESH_EXPIRES_IN', '30d'),

  ADMIN_USERNAME: required('ADMIN_USERNAME'),
  ADMIN_PASSWORD: required('ADMIN_PASSWORD'),
  ADMIN_JWT_SECRET: required('ADMIN_JWT_SECRET'),
  ADMIN_SECRET_KEY: required('ADMIN_SECRET_KEY'),

  TELEGRAM_BOT_TOKEN: optional('TELEGRAM_BOT_TOKEN', ''),

  TABLE_COUNT: parseInt(optional('TABLE_COUNT', '2')),
  BETTING_PHASE_MS: parseInt(optional('BETTING_PHASE_MS', '7000')),
  TICK_MS: parseInt(optional('TICK_MS', '100')),

  ALLOWED_ORIGINS: optional('ALLOWED_ORIGINS', 'http://localhost:3001').split(','),
};
