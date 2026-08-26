import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { authController } from '../controllers/auth.controller';
import { authenticate, optionalAuthenticate } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import {
  changePasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
} from '../schema/auth.schema';

export const authRoutes = Router();

// حد أشد على مسارات الدخول/التسجيل تحديدًا — الحماية الأساسية ضد brute-force
const authLimiter = rateLimit({
  windowMs: env.rateLimitWindowMin * 60 * 1000,
  max: env.authRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // الدخول الناجح لا يستهلك رصيد الحماية من التخمين
});

// إنشاء الحسابات: أدمن فقط (optionalAuthenticate يقرأ التوكن، والخدمة ترفض غير الأدمن —
// الاستثناء الوحيد: أول حساب في نظام فاضي)
authRoutes.post('/register', authLimiter, optionalAuthenticate, validate({ body: registerSchema }), authController.register);
authRoutes.post('/login', authLimiter, validate({ body: loginSchema }), authController.login);
authRoutes.post('/refresh', validate({ body: refreshSchema }), authController.refresh);
authRoutes.post('/logout', validate({ body: refreshSchema }), authController.logout);
authRoutes.get('/me', authenticate, authController.me);
// ⛔ مسارا password-reset/* مُعطَّلان عمدًا: بدون نظام بريد، كان التوكن يُعاد في الاستجابة
// لأي شخص يعرف الإيميل = استيلاء على أي حساب. استعادة كلمة السر تتم عبر الأدمن فقط:
// POST /api/admin/users/:userId/reset-password. أعد تفعيلهما فقط بعد ربط SMTP يُرسل التوكن ولا يُرجعه.
authRoutes.post('/change-password', authenticate, validate({ body: changePasswordSchema }), authController.changePassword);
