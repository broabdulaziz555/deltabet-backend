import { prisma } from '../config/database';
import { redis } from '../config/redis';
import {
  generateServerSeed,
  hashSeed,
  generateCrashPointReal,
  generateCrashPointDemo,
  getMultiplierAtTime,
} from './crashAlgo';
import { AppError, ErrorCodes } from '../utils/errors';
import { maskUsername } from '../utils/mask';
import type { Server as SocketServer } from 'socket.io';
import type { Round, Bet, AccountType } from '@prisma/client';

type GameState = 'WAITING' | 'FLYING' | 'CRASHED' | 'STOPPED';

export class GameEngine {
  private static instance: GameEngine;
  private io: SocketServer | null = null;
  private state: GameState = 'STOPPED';
  private currentRound: Round | null = null;
  private flyInterval: NodeJS.Timeout | null = null;
  private waitTimeout: NodeJS.Timeout | null = null;
  private roundStartTime = 0;
  private currentMultiplier = 1.0;
  private nonce = 0;

  static getInstance(): GameEngine {
    if (!GameEngine.instance) GameEngine.instance = new GameEngine();
    return GameEngine.instance;
  }

  setIo(io: SocketServer) {
    this.io = io;
  }

  async start() {
    const config = await prisma.gameConfig.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
    if (!config.isGameRunning) return;
    await this.recoverOrphans();
    await this.startWaiting();
  }

  async stop() {
    this.state = 'STOPPED';
    if (this.flyInterval) clearInterval(this.flyInterval);
    if (this.waitTimeout) clearTimeout(this.waitTimeout);
    await prisma.gameConfig.update({ where: { id: 1 }, data: { isGameRunning: false } });
  }

  async resume() {
    await prisma.gameConfig.update({ where: { id: 1 }, data: { isGameRunning: true } });
    this.state = 'STOPPED';
    await this.start();
  }

  getState() {
    return {
      state: this.state,
      roundId: this.currentRound?.id,
      multiplier: this.currentMultiplier,
      serverSeedHash: this.currentRound?.serverSeedHash,
    };
  }

  private async recoverOrphans() {
    const flying = await prisma.round.findFirst({ where: { status: 'FLYING' } });
    if (flying) {
      await prisma.bet.updateMany({
        where: { roundId: flying.id, cashedOut: false },
        data: { cashedOut: true, winAmount: BigInt(0), cashoutMultiplier: 0, cashedOutAt: new Date() },
      });
      await prisma.round.update({
        where: { id: flying.id },
        data: { status: 'CRASHED', crashedAt: new Date() },
      });
    }
  }

  private async startWaiting() {
    if (this.state === 'STOPPED') return;
    this.state = 'WAITING';
    this.currentMultiplier = 1.0;

    const config = await prisma.gameConfig.findFirst({ where: { id: 1 } });
    if (!config?.isGameRunning) return;

    const serverSeed = generateServerSeed();
    const serverSeedHash = hashSeed(serverSeed);
    this.nonce++;

    const crashPointReal = generateCrashPointReal(serverSeed, 'global', this.nonce);
    const crashPointDemo = generateCrashPointDemo(serverSeed, 'global', this.nonce);

    this.currentRound = await prisma.round.create({
      data: {
        serverSeed,
        serverSeedHash,
        nonce: this.nonce,
        crashPointReal,
        crashPointDemo,
        status: 'WAITING',
      },
    });

    await redis.set('game:round', JSON.stringify({
      roundId: this.currentRound.id,
      serverSeedHash,
      state: 'WAITING',
    }));

    this.io?.to('global_game').emit('game:waiting', {
      roundId: this.currentRound.id,
      serverSeedHash,
      countdown: config.waitingPhaseSec,
    });

    this.waitTimeout = setTimeout(
      () => this.startFlying(),
      config.waitingPhaseSec * 1000
    );
  }

  private async startFlying() {
    if (!this.currentRound || this.state === 'STOPPED') return;
    this.state = 'FLYING';
    this.roundStartTime = Date.now();

    await prisma.round.update({
      where: { id: this.currentRound.id },
      data: { status: 'FLYING', startedAt: new Date() },
    });

    await redis.set('game:round', JSON.stringify({
      roundId: this.currentRound.id,
      state: 'FLYING',
      startedAt: this.roundStartTime,
    }));

    this.io?.to('global_game').emit('game:start', { roundId: this.currentRound.id });

    this.flyInterval = setInterval(async () => {
      const elapsed = Date.now() - this.roundStartTime;
      this.currentMultiplier = getMultiplierAtTime(elapsed);

      this.io?.to('global_game').emit('game:multiplier', {
        multiplier: this.currentMultiplier,
        elapsedMs: elapsed,
      });

      await this.processAutoCashouts(this.currentMultiplier);

      if (this.currentRound && this.currentMultiplier >= this.currentRound.crashPointReal) {
        await this.triggerCrash();
      }
    }, 100);
  }

  private async processAutoCashouts(currentMultiplier: number) {
    if (!this.currentRound) return;
    const pending = await prisma.bet.findMany({
      where: {
        roundId: this.currentRound.id,
        cashedOut: false,
        autoCashout: { not: null, lte: currentMultiplier },
      },
      include: { user: { select: { id: true, accountType: true, username: true } } },
    });

    for (const bet of pending) {
      const crashPoint = bet.user.accountType === 'DEMO'
        ? this.currentRound.crashPointDemo
        : this.currentRound.crashPointReal;

      if (currentMultiplier < crashPoint) {
        await this.processCashout(bet, bet.autoCashout!, bet.user.username, bet.user.accountType);
      }
    }
  }

  private async processCashout(
    bet: Bet,
    multiplier: number,
    username: string,
    accountType: AccountType
  ) {
    const winAmount = BigInt(Math.floor(Number(bet.betAmount) * multiplier));

    await prisma.$transaction([
      prisma.bet.update({
        where: { id: bet.id },
        data: { cashedOut: true, cashoutMultiplier: multiplier, winAmount, cashedOutAt: new Date() },
      }),
      prisma.user.update({
        where: { id: bet.userId },
        data: { balance: { increment: winAmount } },
      }),
    ]);

    await this.updateRoundPayout(accountType, bet.betAmount, winAmount);
    const houseProfit = bet.betAmount - winAmount;
    if (houseProfit > 0n) await this.creditReferralCommission(bet.userId, houseProfit);

    this.io?.to(`user:${bet.userId}`).emit('wallet:balance:update', { userId: bet.userId });
    this.io?.to('global_game').emit('game:cashout', {
      username: maskUsername(username),
      multiplier,
      winAmount: winAmount.toString(),
    });
  }

  private async updateRoundPayout(accountType: AccountType, _bet: bigint, payout: bigint) {
    if (!this.currentRound) return;
    if (accountType === 'REAL') {
      await prisma.round.update({
        where: { id: this.currentRound.id },
        data: { totalPayoutReal: { increment: payout } },
      });
    } else {
      await prisma.round.update({
        where: { id: this.currentRound.id },
        data: { totalPayoutDemo: { increment: payout } },
      });
    }
  }

  private async creditReferralCommission(userId: number, profit: bigint) {
    if (profit <= 0n) return;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { referredById: true },
    });
    if (!user?.referredById) return;
    const commission = BigInt(Math.floor(Number(profit) * 0.3));
    if (commission <= 0n) return;

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.referredById },
        data: { balance: { increment: commission } },
      }),
      prisma.referralEarning.create({
        data: {
          referrerId: user.referredById,
          referredId: userId,
          roundId: this.currentRound!.id,
          houseProfit: profit,
          commission,
          isPaid: true,
          paidAt: new Date(),
        },
      }),
    ]);

    this.io?.to(`user:${user.referredById}`).emit('wallet:balance:update', { userId: user.referredById });
  }

  private async triggerCrash() {
    if (!this.currentRound) return;
    if (this.flyInterval) clearInterval(this.flyInterval);
    this.flyInterval = null;
    this.state = 'CRASHED';

    const crashPoint = this.currentRound.crashPointReal;

    // Process demo users who survive real crash but have higher demo crash point
    await this.processDemoSurvivors(crashPoint);

    // All remaining uncashed bets = lost
    await prisma.bet.updateMany({
      where: { roundId: this.currentRound.id, cashedOut: false },
      data: { cashedOut: true, winAmount: BigInt(0), cashoutMultiplier: 0, cashedOutAt: new Date() },
    });

    await prisma.round.update({
      where: { id: this.currentRound.id },
      data: { status: 'CRASHED', crashedAt: new Date() },
    });

    this.io?.to('global_game').emit('game:crash', {
      crashPoint,
      roundId: this.currentRound.id,
    });

    await redis.set('game:lastCrash', JSON.stringify({ crashPoint, roundId: this.currentRound.id }));

    setTimeout(() => {
      this.state = 'WAITING';
      this.startWaiting();
    }, 2000);
  }

  private async processDemoSurvivors(realCrashPoint: number) {
    if (!this.currentRound) return;
    const demoPoint = this.currentRound.crashPointDemo;
    if (demoPoint <= realCrashPoint) return;

    // Demo users survive if their crash point is higher — auto-cashout at realCrashPoint - 0.01
    const survivorMultiplier = Math.max(1.01, realCrashPoint - 0.01);

    const demoBets = await prisma.bet.findMany({
      where: {
        roundId: this.currentRound.id,
        cashedOut: false,
        user: { accountType: 'DEMO' },
      },
      include: { user: { select: { id: true, username: true, accountType: true } } },
    });

    for (const bet of demoBets) {
      await this.processCashout(bet, survivorMultiplier, bet.user.username, 'DEMO');
    }
  }

  async placeBet(
    userId: number,
    panelSlot: 1 | 2,
    amount: bigint,
    autoCashout: number | null
  ): Promise<{ betId: number; roundId: number }> {
    if (this.state !== 'WAITING') throw new AppError(ErrorCodes.ROUND_NOT_WAITING, 400);
    if (!this.currentRound) throw new AppError(ErrorCodes.INTERNAL_ERROR, 500);

    const config = await prisma.gameConfig.findFirst({ where: { id: 1 } });
    if (!config?.isGameRunning) throw new AppError(ErrorCodes.GAME_STOPPED, 400);
    if (amount < config.minBet) throw new AppError(ErrorCodes.BET_TOO_SMALL, 400);
    if (amount > config.maxBet) throw new AppError(ErrorCodes.BET_TOO_LARGE, 400);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) throw new AppError(ErrorCodes.ACCOUNT_BANNED, 403);

    // Calculate how much comes from bonus vs main balance
    let mainDeduction = amount;
    let bonusDeduction = 0n;
    if (user.bonusBalance > 0n) {
      bonusDeduction = user.bonusBalance >= amount ? amount : user.bonusBalance;
      mainDeduction = amount - bonusDeduction;
    }

    const totalAvailable = user.balance + user.bonusBalance;
    if (totalAvailable < amount) throw new AppError(ErrorCodes.INSUFFICIENT_BALANCE, 400);

    const roundId = this.currentRound.id;

    const isDemo = user.accountType === 'DEMO';
    const [bet] = await prisma.$transaction([
      prisma.bet.create({
        data: { userId, roundId, panelSlot, betAmount: amount, usedBonus: bonusDeduction, autoCashout },
      }),
      prisma.user.update({
        where: { id: userId },
        data: { balance: { decrement: mainDeduction }, bonusBalance: { decrement: bonusDeduction } },
      }),
      prisma.round.update({
        where: { id: roundId },
        data: isDemo ? { totalBetsDemo: { increment: amount } } : { totalBetsReal: { increment: amount } },
      }),
    ]);

    // Update wagering progress for bonus
    if (bonusDeduction > 0n) {
      await this.updateWageringProgress(userId, amount);
    }

    const username = maskUsername(user.username);
    this.io?.to('global_game').emit('game:bet_placed', {
      username,
      amount: amount.toString(),
      panelSlot,
    });

    return { betId: bet.id, roundId };
  }

  private async updateWageringProgress(userId: number, betAmount: bigint) {
    const grants = await prisma.bonusGrant.findMany({
      where: { userId, isConverted: false },
      orderBy: { createdAt: 'asc' },
    });

    let remaining = betAmount;
    for (const grant of grants) {
      if (remaining <= 0n) break;
      const needed = grant.wageringRequired - grant.wageringProgress;
      const progress = remaining >= needed ? needed : remaining;
      remaining -= progress;

      const newProgress = grant.wageringProgress + progress;
      if (newProgress >= grant.wageringRequired) {
        await prisma.$transaction([
          prisma.bonusGrant.update({
            where: { id: grant.id },
            data: { wageringProgress: newProgress, isConverted: true, convertedAt: new Date() },
          }),
          prisma.user.update({
            where: { id: userId },
            data: { balance: { increment: grant.bonusAmount } },
          }),
        ]);
      } else {
        await prisma.bonusGrant.update({
          where: { id: grant.id },
          data: { wageringProgress: newProgress },
        });
      }
    }
  }

  async cashout(userId: number, panelSlot: 1 | 2): Promise<{ multiplier: number; winAmount: string }> {
    if (this.state !== 'FLYING') throw new AppError(ErrorCodes.ROUND_NOT_FLYING, 400);
    if (!this.currentRound) throw new AppError(ErrorCodes.INTERNAL_ERROR, 500);

    const bet = await prisma.bet.findFirst({
      where: { userId, roundId: this.currentRound.id, panelSlot, cashedOut: false },
      include: { user: { select: { accountType: true, username: true } } },
    });

    if (!bet) throw new AppError(ErrorCodes.BET_NOT_FOUND, 404);

    const crashPoint = bet.user.accountType === 'DEMO'
      ? this.currentRound.crashPointDemo
      : this.currentRound.crashPointReal;

    if (this.currentMultiplier >= crashPoint) {
      throw new AppError(ErrorCodes.ROUND_NOT_FLYING, 400);
    }

    const multiplier = this.currentMultiplier;
    await this.processCashout(bet, multiplier, bet.user.username, bet.user.accountType);

    const winAmount = BigInt(Math.floor(Number(bet.betAmount) * multiplier));
    return { multiplier, winAmount: winAmount.toString() };
  }
}
