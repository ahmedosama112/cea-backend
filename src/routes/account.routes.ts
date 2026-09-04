import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { asyncHandler } from '../utils/asyncHandler';
import { accountController, accountSettingsSchema } from '../controllers/account.controller';
import { authenticate, requireRole } from '../middlewares/auth';
import { validate } from '../middlewares/validate';

export const accountRoutes = Router();
accountRoutes.use(authenticate);

// المهندس يقرأ إعداداته (PIN hash / توقيع) فقط — الكتابة للأدمن حصريًا،
// سواء لنفسه هنا أو لحساب مهندس عبر /api/admin/users/:userId/settings
// إحصاءات مزامنة الجهاز: التطبيق بيبعتها بعد كل مزامنة ناجحة (عدد السراكي على الجهاز + اللي لسه ما اترفعش)
// — الأدمن بيشوفها في إدارة الحسابات جنب عدد السراكي على السيرفر
accountRoutes.post(
  '/sync-stats',
  validate({ body: z.object({ localRecords: z.number().int().min(0).max(1_000_000), unsynced: z.number().int().min(0).max(1_000_000) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { syncLocalRecords: req.body.localRecords, syncUnsynced: req.body.unsynced, syncReportedAt: new Date() },
    });
    res.json({ success: true });
  }),
);

accountRoutes.get('/settings', accountController.get);
accountRoutes.put('/settings', requireRole('ADMIN'), validate({ body: accountSettingsSchema }), accountController.update);
