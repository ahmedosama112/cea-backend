import { z } from 'zod';

// bcrypt يحسب أول 72 بايت فقط؛ UTF-8 قد يستخدم أكثر من بايت للحرف الواحد.
// يُطبَّق على التعيين الجديد فقط، مع الحفاظ على توافق الدخول وكلمة السر الحالية.
export const newPasswordSchema = z.string()
  .min(8, 'كلمة المرور يجب ألا تقل عن 8 أحرف')
  .max(128)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'كلمة المرور يجب ألا تتجاوز 72 بايت UTF-8');

export const registerSchema = z.object({
  email: z.string().email('صيغة الإيميل غير صحيحة').max(190),
  password: newPasswordSchema,
  role: z.enum(['ADMIN', 'ENGINEER']).optional(), // تُقبل فقط من أدمن — تُتجاهل في التسجيل الذاتي
});

export const loginSchema = z.object({
  email: z.string().email('صيغة الإيميل غير صحيحة').max(190),
  password: z.string().min(1, 'أدخل كلمة المرور').max(128),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(200),
});

export const passwordResetRequestSchema = z.object({
  email: z.string().email().max(190),
});

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: newPasswordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: newPasswordSchema,
});
