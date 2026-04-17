import cron from 'node-cron';
import { prisma } from '../config/database';

export function startCronJobs() {
  // Reset demo account balances to 500,000 UZS every day at 00:00 Tashkent
  cron.schedule('0 0 * * *', async () => {
    try {
      const result = await prisma.user.updateMany({
        where: { accountType: 'DEMO' },
        data: { balance: BigInt(500000), bonusBalance: BigInt(0) },
      });
      console.log(`[CRON] Reset ${result.count} demo account balances`);
    } catch (err) {
      console.error('[CRON] Demo balance reset failed:', err);
    }
  }, { timezone: 'Asia/Tashkent' });

  // Reset P2P card daily limits every day at 00:00 Tashkent
  cron.schedule('0 0 * * *', async () => {
    try {
      const result = await prisma.p2PCard.updateMany({
        data: { usedToday: BigInt(0), lastResetAt: new Date() },
      });
      console.log(`[CRON] Reset ${result.count} P2P card daily limits`);
    } catch (err) {
      console.error('[CRON] Card reset failed:', err);
    }
  }, { timezone: 'Asia/Tashkent' });

  // Expire bonus grants every hour
  cron.schedule('0 * * * *', async () => {
    try {
      const expired = await prisma.bonusGrant.findMany({
        where: { isConverted: false, expiresAt: { lt: new Date() } },
        select: { id: true, userId: true, bonusAmount: true },
      });
      for (const grant of expired) {
        await prisma.$transaction([
          prisma.bonusGrant.update({ where: { id: grant.id }, data: { isConverted: true, convertedAt: new Date() } }),
          prisma.user.update({ where: { id: grant.userId }, data: { bonusBalance: { decrement: grant.bonusAmount } } }),
        ]);
      }
      if (expired.length > 0) console.log(`[CRON] Expired ${expired.length} bonus grants`);
    } catch (err) {
      console.error('[CRON] Bonus expiry failed:', err);
    }
  }, { timezone: 'Asia/Tashkent' });

  console.log('[CRON] All jobs scheduled (Asia/Tashkent timezone)');
}
