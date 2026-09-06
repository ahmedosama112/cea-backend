import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import multer from 'multer';
import { AppError } from '../utils/AppError';
import { logActivity } from '../services/activityLog';

// أخطاء ما تتسجلش في سجل النشاط: تجديد التوكن العادي (401 متكرر بطبيعته)،
// وفشل الدخول (متسجل أصلًا كـ LOGIN_FAIL بتفصيل أوضح — تسجيله هنا كمان بيكرره)
const NOISY = (status: number, path: string) =>
  status === 401 && (path.includes('/auth/refresh') || path.includes('/auth/login'));

// صيغة استجابة أخطاء موحدة للـ API كله — بدون تسريب stack traces أو تفاصيل DB للمستخدم
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    if (err.status >= 500) console.error(err);
    // سجل النشاط: عشان الأدمن يعرف سبب مشكلة عند حساب معيّن من كارت الحساب
    if (err.status >= 400 && !NOISY(err.status, _req.originalUrl)) {
      logActivity(_req, 'API_ERR', { status: err.status, detail: err.message });
    }
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

  // (M9) أخطاء multer برسائل واضحة وأكواد صحيحة بدل ما تسقط كـ 500
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: 'حجم الملف أكبر من المسموح', code: 'FILE_TOO_LARGE' });
    }
    return res.status(400).json({ success: false, message: 'خطأ في رفع الملف: ' + err.code, code: 'UPLOAD_ERROR' });
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
  logActivity(_req, 'API_ERR', { status: 500, detail: (err as Error)?.message ?? 'خطأ غير متوقع' });
  return res.status(500).json({ success: false, message: 'حدث خطأ غير متوقع في السيرفر', code: 'INTERNAL_ERROR' });
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ success: false, message: `المسار غير موجود: ${req.method} ${req.path}`, code: 'NOT_FOUND' });
}
