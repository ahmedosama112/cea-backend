import { Router, Request, Response } from 'express';
import { adminRoutes, readSiteNames } from './admin.routes';
import { asyncHandler } from '../utils/asyncHandler';
import { authRoutes } from './auth.routes';
import { accountRoutes } from './account.routes';
import { dailyRoutes } from './daily.routes';
import { filesRoutes } from './files.routes';
import { execRoutes, itemsRoutes } from './items.routes';
import { recordsRoutes } from './records.routes';
import { submissionsRoutes } from './submissions.routes';
import { contractorsRouter, equipmentRouter, inspectorsRouter, irRouter, placesRouter, todosRouter } from './entities.routes';
import { inventoryRoutes } from './inventory.routes';
import { approvalsRoutes } from './approvals.routes';
import { analyticsRoutes } from './analytics.routes';
import { notificationsRoutes } from './notifications.routes';
import { authenticate } from '../middlewares/auth';
import { requireModule } from '../middlewares/moduleGuard';
import { allWindowStates } from '../services/windows';

export const router = Router();

router.use('/auth', authRoutes);
// إعدادات عامة (أسماء المواقع) — قراءة لأي مستخدم مسجّل؛ التعديل من /admin/config فقط
router.get('/config', authenticate, asyncHandler(async (_req: Request, res: Response) => {
  res.json({ success: true, data: await readSiteNames() });
}));
// مواعيد الإرسال والاعتماد — قراءة لأي مستخدم مسجّل (الواجهة بتبني منها العدّاد وبتقفل الأزرار).
// serverNow مقصود: ساعة جهاز المستخدم ممكن تكون غلط، فالواجهة بتحسب فرقها مرة واحدة وتعوّضه في العدّاد.
router.get('/windows', authenticate, asyncHandler(async (_req: Request, res: Response) => {
  res.json({ success: true, data: await allWindowStates(), serverNow: new Date().toISOString() });
}));
router.use('/admin', adminRoutes);
// التنبيهات الداخلية (جرس الهيدر) — متاحة لأي حساب مسجّل؛ الإضافة/التعديل للأدمن (الحارس جوّه الملف)
router.use('/notifications', authenticate, notificationsRoutes);
router.use('/account', accountRoutes);
// بيانات مرجعية — متاحة دايمًا (بتُستخدم في أكتر من وحدة)
router.use('/contractors', contractorsRouter);
router.use('/places', placesRouter);
router.use('/inspectors', inspectorsRouter);
router.use('/items', itemsRoutes);
router.use('/files', filesRoutes);
// وحدات قابلة للتفعيل/الإخفاء لكل حساب — محمية على السيرفر
router.use('/records', authenticate, requireModule('records'), recordsRoutes);
router.use('/submissions', authenticate, requireModule('submissions'), submissionsRoutes);
router.use('/ir-records', authenticate, requireModule('ir'), irRouter);
router.use('/todos', authenticate, requireModule('todo'), todosRouter);
router.use('/exec-records', authenticate, requireModule('site_exec'), execRoutes);
router.use('/daily-records', authenticate, requireModule('site_daily'), dailyRoutes);
router.use('/inventory', authenticate, requireModule('inventory'), inventoryRoutes);
router.use('/approvals', authenticate, requireModule('approvals'), approvalsRoutes);
router.use('/equipment-records', authenticate, requireModule('equipment'), equipmentRouter);
router.use('/analytics', authenticate, requireModule('analytics'), analyticsRoutes);
