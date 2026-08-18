import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email('صيغة الإيميل غير صحيحة').max(190),
  password: z.string().min(8, 'كلمة المرور يجب ألا تقل عن 8 أحرف').max(128),
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
  newPassword: z.string().min(8, 'كلمة المرور يجب ألا تقل عن 8 أحرف').max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8, 'كلمة المرور يجب ألا تقل عن 8 أحرف').max(128),
});
