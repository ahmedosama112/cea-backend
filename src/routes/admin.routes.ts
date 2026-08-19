import { Router } from 'express';
import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { authenticate, requireRole } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { accountSettingsSchema, upsertSettings } from '../controllers/account.controller';
import { ALL_MODULES, DEFAULT_MODULES, MODULE_LABELS } from '../utils/modules';
import { authService } from '../services/auth.service';
import { placeCreateSchema } from '../schema/entities.schema';

// إدارة الأدمن لحسابات المهندسين — البديل الرسمي للوحة تحكم Supabase:
// الأدمن ينشئ الحسابات (عبر /api/auth/register بتوكنه) ويزرع لكل مهندس:
// الأماكن + التوقيع + الـ PIN — والمهندس يقرأهم فقط في تطبيقه.

export const adminRoutes = Router();
adminRoutes.use(authenticate, requireRole('ADMIN'));

const userIdParam = z.object({ userId: z.coerce.bigint() });
const userAndIdParam = z.object({ userId: z.coerce.bigint(), id: z.coerce.bigint() });

async function assertUserExists(userId: bigint) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('المستخدم غير موجود');
  return user;
}

// ── قائمة المستخدمين ──
adminRoutes.get(
  '/users',
  asyncHandler(async (_req: Request, res: Response) => {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, role: true, createdAt: true },
      orderBy: { id: 'asc' },
    });
    res.json({ success: true, data: users });
  }),
);

// ── أماكن مستخدم معيّن ──
adminRoutes.get(
  '/users/:userId/places',
  validate({ params: userIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    await assertUserExists(BigInt(req.params.userId));
    const places = await prisma.place.findMany({ where: { userId: BigInt(req.params.userId) }, orderBy: { name: 'asc' } });
    res.json({ success: true, data: places });
  }),
);

adminRoutes.post(
  '/users/:userId/places',
  validate({ params: userIdParam, body: placeCreateSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await assertUserExists(BigInt(req.params.userId));
    const place = await prisma.place.create({ data: { userId: BigInt(req.params.userId), name: req.body.name } });
    res.status(201).json({ success: true, data: place });
  }),
);

adminRoutes.put(
  '/users/:userId/places/:id',
  validate({ params: userAndIdParam, body: placeCreateSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prisma.place.findFirst({
      where: { id: BigInt(req.params.id), userId: BigInt(req.params.userId) },
    });
    if (!existing) throw AppError.notFound('المكان غير موجود');
    const place = await prisma.place.update({ where: { id: existing.id }, data: { name: req.body.name } });
    res.json({ success: true, data: place });
  }),
);

adminRoutes.delete(
  '/users/:userId/places/:id',
  validate({ params: userAndIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prisma.place.findFirst({
      where: { id: BigInt(req.params.id), userId: BigInt(req.params.userId) },
    });
    if (!existing) throw AppError.notFound('المكان غير موجود');
    await prisma.place.delete({ where: { id: existing.id } });
    res.json({ success: true, data: null });
  }),
);

// ── إعدادات مستخدم معيّن (PIN hash + التوقيع) ──
adminRoutes.get(
  '/users/:userId/settings',
  validate({ params: userIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    await assertUserExists(BigInt(req.params.userId));
    const settings = await prisma.accountSettings.findUnique({ where: { userId: BigInt(req.params.userId) } });
    res.json({ success: true, data: settings ?? { pinHash: null, signatureFileId: null } });
  }),
);

adminRoutes.put(
  '/users/:userId/settings',
  validate({ params: userIdParam, body: accountSettingsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = BigInt(req.params.userId);
    await assertUserExists(userId);
    // ملف التوقيع لازم يكون مملوكًا للأدمن نفسه (هو اللي رفعه) أو للمستخدم الهدف
    const data = await upsertSettings(userId, req.body, [req.user!.id, userId]);
    res.json({ success: true, data });
  }),
);

// ── قائمة الوحدات المتاحة (للواجهة) ──
adminRoutes.get(
  '/modules',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ success: true, data: ALL_MODULES.map((key) => ({ key, label: MODULE_LABELS[key], default: DEFAULT_MODULES.includes(key) })) });
  }),
);

// ── إنشاء حساب مهندس (بديل register بتوكن الأدمن — نفس المنطق، مسار أوضح للواجهة) ──
adminRoutes.post(
  '/users',
  validate({ body: z.object({ email: z.string().email().max(190), password: z.string().min(8).max(128), enabledModules: z.array(z.enum(ALL_MODULES)).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await authService.register(req.body.email, req.body.password, req.user);
    const userId = BigInt(result.user.id);
    if (req.body.enabledModules) await upsertSettings(userId, { enabledModules: req.body.enabledModules }, [req.user!.id, userId]);
    res.status(201).json({ success: true, data: result.user });
  }),
);

// ── إعادة تعيين كلمة سر مهندس (الأدمن يحدد كلمة جديدة ويسلّمها له) ──
adminRoutes.post(
  '/users/:userId/reset-password',
  validate({ params: userIdParam, body: z.object({ newPassword: z.string().min(8).max(128) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = BigInt(req.params.userId);
    await assertUserExists(userId);
    await authService.adminSetPassword(userId, req.body.newPassword);
    res.json({ success: true, data: null });
  }),
);
