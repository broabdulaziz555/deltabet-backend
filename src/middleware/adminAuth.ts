import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError, ErrorCodes } from '../utils/errors';
import { AdminRole } from '@prisma/client';

export interface AdminRequest extends Request {
  adminId?: number;
  adminRole?: AdminRole;
}

export function adminAuthMiddleware(req: AdminRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return next(new AppError(ErrorCodes.UNAUTHORIZED, 401));

  try {
    const payload = jwt.verify(token, env.ADMIN_JWT_SECRET) as {
      adminId: number;
      role: AdminRole;
    };
    req.adminId = payload.adminId;
    req.adminRole = payload.role;
    next();
  } catch {
    next(new AppError(ErrorCodes.UNAUTHORIZED, 401));
  }
}

export function requireRole(...roles: AdminRole[]) {
  return (req: AdminRequest, res: Response, next: NextFunction) => {
    if (!req.adminRole || !roles.includes(req.adminRole)) {
      return next(new AppError(ErrorCodes.FORBIDDEN, 403));
    }
    next();
  };
}
