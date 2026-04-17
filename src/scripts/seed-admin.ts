import 'dotenv/config';
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding DeltaBet database...');

  // Game config
  await prisma.gameConfig.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });
  console.log('✅ Game config initialized');

  // First superadmin
  const hash = await bcrypt.hash('changeme123', 12);
  await prisma.adminUser.upsert({
    where: { username: 'admin' },
    create: { username: 'admin', passwordHash: hash, role: 'SUPERADMIN' },
    update: {},
  });
  console.log('✅ Superadmin created: admin / changeme123');
  console.log('⚠️  CHANGE THIS PASSWORD IMMEDIATELY via /adminpanel');

  // Sample P2P cards for testing
  const sampleCards = [
    { cardNumber: '8600123456789012', ownerName: 'Alisher Umarov', method: 'UZCARD' as const, dailyLimit: BigInt(50000000) },
    { cardNumber: '9860123456789012', ownerName: 'Kamola Yusupova', method: 'HUMO' as const, dailyLimit: BigInt(30000000) },
    { cardNumber: '4100123456789012', ownerName: 'Sardor Toshmatov', method: 'CLICK' as const, dailyLimit: BigInt(20000000) },
  ];

  for (const card of sampleCards) {
    const existing = await prisma.p2PCard.findFirst({ where: { cardNumber: card.cardNumber } });
    if (!existing) {
      await prisma.p2PCard.create({ data: card });
    }
  }
  console.log('✅ Sample P2P cards created');

  // Sample promo codes
  const samplePromos = [
    { code: 'WELCOME50', type: 'DEPOSIT_MATCH' as const, value: 50, wageringMultiplier: 3, createdBy: 1 },
    { code: 'FREE10K', type: 'FIXED_CREDIT' as const, value: 10000, wageringMultiplier: 5, createdBy: 1 },
  ];

  for (const promo of samplePromos) {
    const existing = await prisma.promoCode.findUnique({ where: { code: promo.code } });
    if (!existing) {
      await prisma.promoCode.create({ data: promo });
    }
  }
  console.log('✅ Sample promo codes created');

  console.log('\n🎉 Seeding complete!');
  console.log('   Admin login: admin / changeme123');
  console.log('   Admin URL: /adminpanel');
}

main()
  .catch((e) => { console.error('❌ Seed failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
