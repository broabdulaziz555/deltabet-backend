import { env } from '../config/env';
import { logger } from './logger';

/**
 * Send a Telegram message to a user.
 * Only fires if TELEGRAM_BOT_TOKEN is set and user has telegram_id.
 * Fails silently — never blocks the main flow.
 */
export async function sendTelegramMessage(
  telegramId: number | null | undefined,
  text: string
): Promise<void> {
  if (!telegramId || !env.TELEGRAM_BOT_TOKEN) return;

  try {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    telegramId,
        text,
        parse_mode: 'HTML',
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn('Telegram notify failed', { telegramId, status: res.status, body });
    }
  } catch (err: unknown) {
    // Network error — log and move on, never throw
    logger.warn('Telegram notify error', { telegramId, error: (err as Error).message });
  }
}

// ─── Message templates ────────────────────────────────────────────────────────

export function msgDepositApproved(amount: number, bonus: number): string {
  const bonusLine = bonus > 0
    ? `\n🎁 <b>Bonus:</b> +${bonus.toLocaleString()} so'm (kredit)`
    : '';
  return (
    `✅ <b>Depozit tasdiqlandi</b>\n` +
    `💰 <b>Summa:</b> ${amount.toLocaleString()} so'm${bonusLine}\n\n` +
    `Balansingiz yangilandi. O'yinga xush kelibsiz! 🚀`
  );
}

export function msgDepositRejected(amount: number, note: string): string {
  return (
    `❌ <b>Depozit rad etildi</b>\n` +
    `💰 <b>So'ralgan summa:</b> ${amount.toLocaleString()} so'm\n` +
    (note ? `📝 <b>Sabab:</b> ${note}\n` : '') +
    `\nSavollar bo'lsa admin bilan bog'laning.`
  );
}

export function msgWithdrawalApproved(amount: number): string {
  return (
    `✅ <b>Pul yechish tasdiqlandi</b>\n` +
    `💸 <b>Summa:</b> ${amount.toLocaleString()} so'm\n\n` +
    `Pul kartangizga o'tkazildi. Rahmat!`
  );
}

export function msgWithdrawalRejected(amount: number, note: string): string {
  return (
    `❌ <b>Pul yechish rad etildi</b>\n` +
    `💸 <b>Summa:</b> ${amount.toLocaleString()} so'm\n` +
    (note ? `📝 <b>Sabab:</b> ${note}\n` : '') +
    `\nBalansingiz qaytarildi. Savollar bo'lsa admin bilan bog'laning.`
  );
}
