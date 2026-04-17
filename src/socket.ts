import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import { prisma } from './config/database';
import { GameEngine } from './services/gameEngine';
import { maskUsername } from './utils/mask';
import { env } from './config/env';

let io: SocketServer;

export function initSocket(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: {
      origin: env.CORS_ORIGINS.split(','),
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // Auth middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      socket.data.userId = null;
      socket.data.accountType = null;
      return next();
    }
    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as { userId: number; accountType: string };
      socket.data.userId = payload.userId;
      socket.data.accountType = payload.accountType;
      next();
    } catch {
      socket.data.userId = null;
      socket.data.accountType = null;
      next();
    }
  });

  io.on('connection', async (socket) => {
    socket.join('global_game');
    socket.join('global_chat');

    const userId = socket.data.userId;
    if (userId) {
      socket.join(`user:${userId}`);
      await prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
    }

    // Send current game state on connect
    const state = GameEngine.getInstance().getState();
    socket.emit('game:state', state);

    // Send last 20 chat messages on connect
    const chatMessages = await prisma.chatMessage.findMany({
      where: { isDeleted: false },
      include: { user: { select: { username: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    socket.emit('chat:history', chatMessages.reverse().map(m => ({
      id: m.id,
      username: maskUsername(m.user.username),
      message: m.message,
      createdAt: m.createdAt,
    })));

    // Chat send
    socket.on('chat:send', async (data: { message: string }) => {
      if (!userId) return socket.emit('error', { code: 'UNAUTHORIZED' });

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { isChatBanned: true, chatBanUntil: true, username: true },
      });
      if (!user) return;

      if (user.isChatBanned) {
        if (user.chatBanUntil && user.chatBanUntil < new Date()) {
          await prisma.user.update({ where: { id: userId }, data: { isChatBanned: false } });
        } else {
          return socket.emit('error', { code: 'CHAT_BANNED' });
        }
      }

      const message = String(data.message || '').slice(0, 200).trim();
      if (!message) return;

      const saved = await prisma.chatMessage.create({
        data: { userId, message },
      });

      io.to('global_chat').emit('chat:message', {
        id: saved.id,
        username: maskUsername(user.username),
        message,
        createdAt: saved.createdAt,
      });
    });

    // Balance request
    socket.on('wallet:balance', async () => {
      if (!userId) return;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { balance: true, bonusBalance: true },
      });
      socket.emit('wallet:balance', user);
    });

    socket.on('disconnect', () => {
      // cleanup if needed
    });
  });

  GameEngine.getInstance().setIo(io);
  return io;
}

export function getIo(): SocketServer {
  return io;
}
