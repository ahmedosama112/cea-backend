import { Request, Response } from 'express';
import { authService } from '../services/auth.service';
import { prisma } from '../config/prisma';
import { asyncHandler } from '../utils/asyncHandler';

export const authController = {
  register: asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body;
    // req.user موجود لو الطلب جاي بتوكن (optionalAuthenticate في الراوت) — الخدمة تتحقق من الدور
    const result = await authService.register(email, password, req.user);
    res.status(201).json({ success: true, data: result });
  }),

  login: asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body;
    const result = await authService.login(email, password);
    res.json({ success: true, data: result });
  }),

  refresh: asyncHandler(async (req: Request, res: Response) => {
    const result = await authService.refresh(req.body.refreshToken);
    res.json({ success: true, data: result });
  }),

  logout: asyncHandler(async (req: Request, res: Response) => {
    await authService.logout(req.body.refreshToken);
    res.json({ success: true, data: null });
  }),

  me: asyncHandler(async (req: Request, res: Response) => {
    const u = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { title: true } });
    res.json({ success: true, data: { id: req.user!.id.toString(), email: req.user!.email, role: req.user!.role, title: u?.title ?? null } });
  }),

  requestPasswordReset: asyncHandler(async (req: Request, res: Response) => {
    const result = await authService.requestPasswordReset(req.body.email);
    // استجابة موحّدة سواء الإيميل موجود أو لا (منع تعداد الحسابات) —
    // التوكن يُعاد مؤقتًا لحين ربط نظام بريد، انظر auth.service.ts
    res.json({
      success: true,
      data: {
        message: 'إذا كان الإيميل مسجلاً، تم إنشاء رمز استعادة',
        ...(result ? { resetToken: result.resetToken } : {}),
      },
    });
  }),

  confirmPasswordReset: asyncHandler(async (req: Request, res: Response) => {
    await authService.confirmPasswordReset(req.body.token, req.body.newPassword);
    res.json({ success: true, data: { message: 'تم تغيير كلمة المرور — سجّل الدخول بها الآن' } });
  }),

  changePassword: asyncHandler(async (req: Request, res: Response) => {
    await authService.changePassword(req.user!.id, req.body.currentPassword, req.body.newPassword);
    res.json({ success: true, data: { message: 'تم تغيير كلمة المرور' } });
  }),
};
