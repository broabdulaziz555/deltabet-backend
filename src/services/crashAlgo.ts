import { createHmac, createHash, randomBytes } from 'crypto';

export function generateServerSeed(): string {
  return randomBytes(32).toString('hex');
}

export function hashSeed(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

export function generateCrashPointReal(
  serverSeed: string,
  clientSeed: string,
  nonce: number
): number {
  const hash = createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest('hex');
  const h = parseInt(hash.slice(0, 8), 16);
  const e = 2 ** 32;
  // 5% house edge: 1 in 20 rounds crashes at 1.00x immediately
  if (h % 20 === 0) return 1.0;
  const crash = Math.floor((99 / (1 - h / e)) * 100) / 100;
  return Math.max(1.0, Math.min(1000.0, crash));
}

export function generateCrashPointDemo(
  serverSeed: string,
  clientSeed: string,
  nonce: number
): number {
  const hash = createHmac('sha256', `DEMO_${serverSeed}`)
    .update(`${clientSeed}:${nonce}`)
    .digest('hex');
  const h = parseInt(hash.slice(0, 8), 16);
  const e = 2 ** 32;
  // Only 1 in 40 rounds crashes immediately (half house edge visually)
  if (h % 40 === 0) return 1.0;
  const baseCrash = Math.floor((99 / (1 - h / e)) * 100) / 100;
  // Boost curve: multiply by 1.8–2.2x to feel luckier
  const boost = 1.8 + (h % 100) / 250;
  return Math.max(1.01, Math.min(1000.0, Math.round(baseCrash * boost * 100) / 100));
}

export function getMultiplierAtTime(elapsedMs: number): number {
  return Math.floor(Math.pow(Math.E, 0.00006 * elapsedMs) * 100) / 100;
}
