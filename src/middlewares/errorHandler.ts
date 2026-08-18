import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from '../utils/AppError';

// صيغة استجابة أخطاء موحدة للـ API كله — بدون تسريب stack traces أو تفاصيل DB للمستخدم
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    if (err.status >= 500) console.error(err);
    return res.status(err.status).json({ success: false, message: err.message, code: err.code, details: err.details });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      message: 'بيانات غير صحيحة',
      code: 'VALIDATION_ERROR',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return res.status(409).json({ success: false, message: 'قيمة مكررة — العنصر موجود بالفعل', code: 'CONFLICT' });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'العنصر غير موجود', code: 'NOT_FOUND' });
    }
  }

  console.error('Unhandled error:', err);
  return res.status(500).json({ success: false, message: 'حدث خطأ غير متوقع في السيرفر', code: 'INTERNAL_ERROR' });
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ success: false, message: `المسار غير موجود: ${req.method} ${req.path}`, code: 'NOT_FOUND' });
}
