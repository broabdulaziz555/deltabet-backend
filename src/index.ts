import 'dotenv/config';
import './utils/bigint';
import { createServer } from 'http';
import { app } from './app';
import { initSocket } from './socket';
import { GameEngine } from './services/gameEngine';
import { startCronJobs } from './jobs/cron';
import { prisma } from './config/database';
import { redis } from './config/redis';
import { env } from './config/env';

const PORT = parseInt(env.PORT, 10);
const httpServer = createServer(app);

async function bootstrap() {
  try {
    await prisma.$connect();
    console.log('✅ Database connected');

    initSocket(httpServer);
    console.log('✅ Socket.io initialized');

    await GameEngine.getInstance().start();
    console.log('✅ Game engine started');

    startCronJobs();
    console.log('✅ Cron jobs started');

    httpServer.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 DeltaBet API running on port ${PORT}`);
      console.log(`   Admin panel: http://localhost:${PORT}/adminpanel`);
      console.log(`   Health:      http://localhost:${PORT}/health`);
    });
  } catch (err) {
    console.error('❌ Bootstrap failed:', err);
    process.exit(1);
  }
}

bootstrap();

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await GameEngine.getInstance().stop();
  await prisma.$disconnect();
  await redis.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await GameEngine.getInstance().stop();
  await prisma.$disconnect();
  await redis.quit();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
