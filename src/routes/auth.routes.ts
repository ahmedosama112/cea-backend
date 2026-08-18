import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { authController } from '../controllers/auth.controller';
import { authenticate, optionalAuthenticate } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import {
  changePasswordSchema,
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
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
});

// إنشاء الحسابات: أدمن فقط (optionalAuthenticate يقرأ التوكن، والخدمة ترفض غير الأدمن —
// الاستثناء الوحيد: أول حساب في نظام فاضي)
authRoutes.post('/register', authLimiter, optionalAuthenticate, validate({ body: registerSchema }), authController.register);
authRoutes.post('/login', authLimiter, validate({ body: loginSchema }), authController.login);
authRoutes.post('/refresh', validate({ body: refreshSchema }), authController.refresh);
authRoutes.post('/logout', validate({ body: refreshSchema }), authController.logout);
authRoutes.get('/me', authenticate, authController.me);
authRoutes.post('/password-reset/request', authLimiter, validate({ body: passwordResetRequestSchema }), authController.requestPasswordReset);
authRoutes.post('/password-reset/confirm', authLimiter, validate({ body: passwordResetConfirmSchema }), authController.confirmPasswordReset);
authRoutes.post('/change-password', authenticate, validate({ body: changePasswordSchema }), authController.changePassword);
