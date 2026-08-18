import { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/AppError';
import { verifyAccessToken } from '../utils/tokens';

export interface AuthUser {
  id: bigint;
  email: string;
  role: 'ADMIN' | 'ENGINEER';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// كل route كتابة/قراءة على بيانات المستخدم لازم يمر من هنا أولاً — التحقق على مستوى الـ API
// وليس فقط إخفاء أزرار في الواجهة
export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(AppError.unauthorized());
  }
  const token = header.slice('Bearer '.length);
  try {
    const payload = verifyAccessToken(token);
    req.user = { id: BigInt(payload.sub), email: payload.email, role: payload.role };
    next();
  } catch {
    next(AppError.unauthorized('انتهت صلاحية الجلسة أو التوكن غير صالح'));
  }
}

// يقرأ التوكن لو موجود بدون ما يرفض الطلب لو غايب — للمسارات اللي سلوكها بيختلف حسب الدور
// (مثل register: مسموح بدون توكن فقط لتمهيد أول حساب في نظام فاضي)
export function optionalAuthenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const payload = verifyAccessToken(header.slice('Bearer '.length));
      req.user = { id: BigInt(payload.sub), email: payload.email, role: payload.role };
    } catch {
      // توكن غير صالح في مسار اختياري = زائر بدون توكن
    }
  }
  next();
}

export function requireRole(...roles: Array<'ADMIN' | 'ENGINEER'>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(AppError.unauthorized());
    if (!roles.includes(req.user.role)) return next(AppError.forbidden());
    next();
  };
}
