import { Router } from 'express';
import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { authenticate, requireRole } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { accountSettingsSchema } from '../controllers/account.controller';
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
    const { pinHash, signatureFileId } = req.body as { pinHash?: string | null; signatureFileId?: bigint | null };

    // ملف التوقيع لازم يكون مملوكًا للأدمن نفسه (هو اللي رفعه) أو للمستخدم الهدف
    if (signatureFileId) {
      const file = await prisma.file.findFirst({
        where: { id: signatureFileId, userId: { in: [req.user!.id, userId] } },
      });
      if (!file) throw AppError.validation('ملف التوقيع غير موجود');
    }

    const data = {
      ...(pinHash !== undefined ? { pinHash } : {}),
      ...(signatureFileId !== undefined ? { signatureFileId } : {}),
    };
    const settings = await prisma.accountSettings.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    res.json({ success: true, data: settings });
  }),
);
