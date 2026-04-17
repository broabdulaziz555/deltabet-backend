import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError, ErrorCodes } from '../utils/errors';

export interface AuthRequest extends Request {
  userId?: number;
  accountType?: string;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return next(new AppError(ErrorCodes.UNAUTHORIZED, 401));

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { userId: number; accountType: string };
    req.userId = payload.userId;
    req.accountType = payload.accountType;
    next();
  } catch {
    next(new AppError(ErrorCodes.UNAUTHORIZED, 401));
  }
}
