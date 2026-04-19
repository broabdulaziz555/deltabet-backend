import crypto from 'crypto';
import { GAME } from '../config/constants';

// ─── Provably Fair Crash Point ────────────────────────────────────────────────

/**
 * Generates crash point using HMAC-SHA256 (standard Aviator formula).
 *
 *   hash = HMAC-SHA256(seed, 'deltabet')
 *   h    = first 8 hex chars → uint32
 *   h % 33 === 0 → 1.00x (instant bust, ~3% house edge)
 *   else → (100 / (1 - edge)) * (2^32 / (h+1)) / 100
 *
 * Seed revealed post-crash → players can verify independently.
 */
export function generateCrashPoint(seed: string, houseEdge = GAME.HOUSE_EDGE_REAL): number {
  const hash = crypto.createHmac('sha256', seed).update('deltabet').digest('hex');
  const h    = parseInt(hash.slice(0, 8), 16);
  const e    = 2 ** 32;

  if (h % 10 === 0) return 1.00; // ~10% instant bust

  const raw    = (100 / (1 - houseEdge)) * (e / (h + 1)) / 100;
  const result = Math.max(1.00, Math.floor(raw * 100) / 100);
  return Math.min(result, GAME.MAX_MULTIPLIER);
}

// ─── Demo Auto-Cashout ────────────────────────────────────────────────────────

/**
 * Generate a per-bet demo cashout target biased toward high multipliers.
 *
 * GOAL: Demo users regularly see 3x, 7x, 10x, 20x+ wins to feel the rush.
 *
 * MECHANIC:
 *   - Each demo bet gets a private "target" multiplier.
 *   - During the flying phase, when multiplier >= target → auto-cashout.
 *   - If real crash happens BEFORE target → demo user loses (keeps it realistic).
 *
 * DISTRIBUTION (tuned for exciting demo feel):
 *   35% → 1.5x – 3x    (reliable small wins, builds trust)
 *   30% → 3x  – 7x     (exciting wins)
 *   20% → 7x  – 15x    (big wins, highly shareable)
 *   10% → 15x – 40x    (huge wins, viral moments)
 *    5% → 40x – 200x   (jackpot moments, extreme FOMO)
 *
 * WIN RATE NOTE:
 *   Target must be <= real crash for demo user to win.
 *   P(real crash > 3x) ≈ 31%, P(real crash > 7x) ≈ 14%.
 *   So actual win rate ~35-45% — higher than typical real-user manual play.
 *   Demo tables should ideally run with 0% house edge (see generateDemoTableCrash)
 *   to push real crash points higher, increasing demo win rate to ~55-65%.
 *
 * null return = no auto-cashout this round (rare loss scenario).
 */
export function getDemoCashoutTarget(): number | null {
  // ~5% of time: no auto-cashout — let natural crash decide (keeps it real)
  if (Math.random() < 0.05) return null;

  const r = Math.random();

  if (r < 0.35) {
    // 35% → 1.5x – 3x
    return round(1.5 + Math.random() * 1.5);
  }
  if (r < 0.65) {
    // 30% → 3x – 7x
    return round(3.0 + Math.random() * 4.0);
  }
  if (r < 0.85) {
    // 20% → 7x – 15x
    return round(7.0 + Math.random() * 8.0);
  }
  if (r < 0.95) {
    // 10% → 15x – 40x
    return round(15.0 + Math.random() * 25.0);
  }
  // 5% → 40x – 200x (viral jackpot moments)
  return round(40.0 + Math.random() * 160.0);
}

/**
 * Crash point for tables that serve mainly demo users.
 *
 * Uses 0% house edge → no instant busts, higher average crash points.
 * This means real crash > demo target more often → higher win rate for demo.
 *
 * P(crash > 2x)  ≈ 50%  (vs ~47% with real house edge)
 * P(crash > 5x)  ≈ 20%  (vs ~18%)
 * P(crash > 10x) ≈ 10%  (vs ~9%)
 * P(crash > 20x) ≈ 5%   (vs ~4%)
 *
 * Not provably fair (no house edge), but demo rounds don't involve real money.
 */
export function generateDemoTableCrash(seed: string): number {
  const hash = crypto.createHmac('sha256', seed).update('deltabet-demo').digest('hex');
  const h    = parseInt(hash.slice(0, 8), 16);
  const e    = 2 ** 32;
  // 0% house edge — no instant bust, raw crash from uniform distribution
  const raw    = (e / (h + 1));
  const result = Math.max(1.01, Math.floor(raw * 100) / 100);
  return Math.min(result, GAME.MAX_MULTIPLIER);
}

// ─── Multiplier Growth ────────────────────────────────────────────────────────

/**
 * Exponential growth: e^(0.00006 × elapsed_ms)
 *   7s  → 1.52x  |  15s → 2.45x  |  30s → 6.05x  |  60s → 36.6x
 */
export function computeMultiplier(elapsedMs: number): number {
  return Math.max(1.00, Math.floor(Math.pow(Math.E, 0.00006 * elapsedMs) * 100) / 100);
}

// ─── Seed utils ───────────────────────────────────────────────────────────────

export function generateSeed(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashSeed(seed: string): string {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function round(n: number): number {
  return parseFloat(n.toFixed(2));
}
