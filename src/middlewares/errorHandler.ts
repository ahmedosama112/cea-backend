import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import multer from 'multer';
import { AppError } from '../utils/AppError';
import { logActivity } from '../services/activityLog';
import { errorDiagnostics } from '../utils/errorDiagnostics';

// أخطاء ما تتسجلش في سجل النشاط: تجديد التوكن العادي (401 متكرر بطبيعته)،
// وفشل الدخول (متسجل أصلًا كـ LOGIN_FAIL بتفصيل أوضح — تسجيله هنا كمان بيكرره)
const NOISY = (status: number, path: string) =>
  status === 401 && (path.includes('/auth/refresh') || path.includes('/auth/login'));

// صيغة استجابة أخطاء موحدة للـ API كله — بدون تسريب stack traces أو تفاصيل DB للمستخدم
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  // body-parser قد يضع جسم الطلب (بما فيه كلمة المرور) في الخطأ أو رسالته.
  // الأنواع والحالات المعروفة فقط؛ لا نطبع الخطأ الخام أو أي مقتطف من المدخلات.
  if (err instanceof Error) {
    const bodyError = err as Error & { type?: string; status?: number };
    const invalidJson = bodyError.type === 'entity.parse.failed' && bodyError.status === 400;
    const tooLarge = bodyError.type === 'entity.too.large' && bodyError.status === 413;
    if (invalidJson || tooLarge) {
      const status = tooLarge ? 413 : 400;
      const message = tooLarge ? 'حجم الطلب أكبر من المسموح' : 'صيغة JSON غير صحيحة';
      console.warn('Request body rejected:', { type: bodyError.type, status });
      logActivity(_req, 'API_ERR', { status, detail: message });
      return res.status(status).json({
        success: false,
        message,
        code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR',
      });
    }
  }

  if (err instanceof AppError) {
    if (err.status >= 500) console.error('Application error:', { code: err.code, status: err.status });
    // سجل النشاط: عشان الأدمن يعرف سبب مشكلة عند حساب معيّن من كارت الحساب
    if (err.status >= 400 && !NOISY(err.status, _req.originalUrl)) {
      logActivity(_req, 'API_ERR', { status: err.status, detail: err.message });
    }
    return res.status(err.status).json({ success: false, message: err.message, code: err.code, details: err.details });
  }

  if (err instanceof ZodError) {
    // سجل النشاط: أخطاء التحقق هي أكتر سبب لـ"سجل لسه ما اترفعش" — من غيرها الأدمن ما كانش بيشوف السبب
    // (حصل فعليًا: 86 × 400 على /api/records في يوم واحد ومفيش سطر واحد في السجل)
    const fields = err.issues.slice(0, 3).map((i) => `${i.path.join('.') || '?'}: ${i.message}`).join(' · ');
    logActivity(_req, 'API_ERR', { status: 400, detail: 'بيانات غير صحيحة — ' + fields });
    return res.status(400).json({
      success: false,
      message: 'بيانات غير صحيحة',
      code: 'VALIDATION_ERROR',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  // (M9) أخطاء multer برسائل واضحة وأكواد صحيحة بدل ما تسقط كـ 500
  if (err instanceof multer.MulterError) {
    logActivity(_req, 'API_ERR', { status: 400, detail: 'ملف مرفوض — ' + err.code });
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

  console.error('Unhandled error:', errorDiagnostics(err, _req));
  logActivity(_req, 'API_ERR', { status: 500, detail: 'خطأ غير متوقع' });
  return res.status(500).json({ success: false, message: 'حدث خطأ غير متوقع في السيرفر', code: 'INTERNAL_ERROR' });
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ success: false, message: `المسار غير موجود: ${req.method} ${req.path}`, code: 'NOT_FOUND' });
}
