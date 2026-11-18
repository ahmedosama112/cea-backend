import { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/AppError';
import { verifyAccessToken } from '../utils/tokens';
import { prisma } from '../config/prisma';
import { assertServiceOpenFor } from '../services/maintenance';

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

// تحديث "آخر ظهور" — خفيف: مرة كل دقيقة لكل مستخدم على الأكتر (مش مع كل طلب)
const lastSeenTouched = new Map<string, number>();
function touchLastSeen(userId: bigint) {
  const k = userId.toString();
  const now = Date.now();
  if ((lastSeenTouched.get(k) ?? 0) > now - 60_000) return;
  lastSeenTouched.set(k, now);
  prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
}

// كل route كتابة/قراءة على بيانات المستخدم لازم يمر من هنا أولاً — التحقق على مستوى الـ API
// وليس فقط إخفاء أزرار في الواجهة
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(AppError.unauthorized());
  }
  const token = header.slice('Bearer '.length);
  let user: AuthUser | null;
  try {
    const payload = verifyAccessToken(token);
    user = await prisma.user.findUnique({ where: { id: BigInt(payload.sub) }, select: { id: true, email: true, role: true } });
  } catch {
    return next(AppError.unauthorized('انتهت صلاحية الجلسة أو التوكن غير صالح'));
  }
  if (!user) return next(AppError.unauthorized());
  // وضع الإيقاف: غير الأدمن بياخد 503 MAINTENANCE على أي مسار محمي
  try {
    await assertServiceOpenFor(user.role);
  } catch (e) {
    return next(e);
  }
  req.user = user;
  touchLastSeen(req.user.id);
  next();
}

// يقرأ التوكن لو موجود بدون ما يرفض الطلب لو غايب — للمسارات اللي سلوكها بيختلف حسب الدور
// (مثل register: مسموح بدون توكن فقط لتمهيد أول حساب في نظام فاضي)
export async function optionalAuthenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const payload = verifyAccessToken(header.slice('Bearer '.length));
      const user = await prisma.user.findUnique({ where: { id: BigInt(payload.sub) }, select: { id: true, email: true, role: true } });
      if (!user) return next(AppError.unauthorized());
      req.user = user;
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
