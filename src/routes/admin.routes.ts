import { Router } from 'express';
import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { authenticate, requireRole } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { accountSettingsSchema, upsertSettings, serializeSettings } from '../controllers/account.controller';
import { ALL_MODULES, DEFAULT_MODULES, MODULE_LABELS, ALL_FEATURES, DEFAULT_FEATURES } from '../utils/modules';
import { authService } from '../services/auth.service';
import { placeCreateSchema, contractorCreateSchema, contractorUpdateSchema } from '../schema/entities.schema';
import { arabizeRateTypes, toEnum, RateTypeAr } from '../utils/rateType';
import { storage } from '../services/storage';
import { runBackupToDrive } from '../services/backup';
import { getApprovalLevels, setApprovalLevels } from '../services/approvalChain';

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

// ── إعدادات عامة: أسماء المواقع/المشاريع (يعدّلها الأدمن وتظهر في كل دروب داون "الموقع") ──
const SITE_NAME_DEFAULTS: Record<string, string> = { site1Name: 'كومباوند جريني', site2Name: 'أزاليا' };

// تُستخدم هنا وفي GET /api/config العام (لكل المستخدمين — الأسماء مش بيانات حساسة)
export async function readSiteNames(): Promise<Record<string, string>> {
  const rows = await prisma.appConfig.findMany({ where: { key: { in: Object.keys(SITE_NAME_DEFAULTS) } } });
  const data = { ...SITE_NAME_DEFAULTS };
  for (const r of rows) data[r.key] = r.value;
  return data;
}

adminRoutes.get(
  '/config',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ success: true, data: await readSiteNames() });
  }),
);

adminRoutes.patch(
  '/config',
  validate({ body: z.object({ site1Name: z.string().trim().min(1).max(60).optional(), site2Name: z.string().trim().min(1).max(60).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const entries = Object.entries(req.body as Record<string, string>).filter(([k]) => k in SITE_NAME_DEFAULTS);
    for (const [key, value] of entries) {
      await prisma.appConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
    res.json({ success: true, data: await readSiteNames() });
  }),
);

// ── قائمة المستخدمين ──
adminRoutes.get(
  '/users',
  asyncHandler(async (_req: Request, res: Response) => {
    const users = await prisma.user.findMany({
      select: {
        id: true, email: true, role: true, title: true, project: true, site: true, approvalLevel: true, lastSeenAt: true, createdAt: true,
        syncLocalRecords: true, syncUnsynced: true, syncReportedAt: true,
      },
      orderBy: { id: 'asc' },
    });
    // عدد السراكي المسجلة على السيرفر لكل حساب (استعلام واحد مجمّع)
    const counts = await prisma.record.groupBy({ by: ['userId'], _count: { _all: true } });
    const byUser = new Map(counts.map((c) => [c.userId.toString(), c._count._all]));
    res.json({ success: true, data: users.map((u) => ({ ...u, recordsCount: byUser.get(u.id.toString()) ?? 0 })) });
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
    const place = await prisma.place.create({ data: { userId: BigInt(req.params.userId), name: req.body.name, note: req.body.note?.trim() || null } });
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
    const place = await prisma.place.update({ where: { id: existing.id }, data: { name: req.body.name, ...(req.body.note !== undefined ? { note: req.body.note?.trim() || null } : {}) } });
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

// ── مقاولو مستخدم معيّن (الأدمن يزرعهم — المهندس يقرأهم فقط) ──
const contractorToData = (b: Record<string, unknown>) => ({ ...b, ...(b.rateType ? { rateType: toEnum(b.rateType as RateTypeAr) } : {}) });

adminRoutes.get(
  '/users/:userId/contractors',
  validate({ params: userIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    await assertUserExists(BigInt(req.params.userId));
    const rows = await prisma.contractor.findMany({ where: { userId: BigInt(req.params.userId) }, orderBy: { name: 'asc' } });
    res.json({ success: true, data: arabizeRateTypes(rows) });
  }),
);

adminRoutes.post(
  '/users/:userId/contractors',
  validate({ params: userIdParam, body: contractorCreateSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await assertUserExists(BigInt(req.params.userId));
    const row = await prisma.contractor.create({ data: { ...(contractorToData(req.body) as object), userId: BigInt(req.params.userId) } as never });
    res.status(201).json({ success: true, data: arabizeRateTypes(row) });
  }),
);

adminRoutes.put(
  '/users/:userId/contractors/:id',
  validate({ params: userAndIdParam, body: contractorUpdateSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prisma.contractor.findFirst({ where: { id: BigInt(req.params.id), userId: BigInt(req.params.userId) } });
    if (!existing) throw AppError.notFound('المقاول غير موجود');
    const row = await prisma.contractor.update({ where: { id: existing.id }, data: contractorToData(req.body) as never });
    res.json({ success: true, data: arabizeRateTypes(row) });
  }),
);

adminRoutes.delete(
  '/users/:userId/contractors/:id',
  validate({ params: userAndIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prisma.contractor.findFirst({ where: { id: BigInt(req.params.id), userId: BigInt(req.params.userId) } });
    if (!existing) throw AppError.notFound('المقاول غير موجود');
    await prisma.contractor.delete({ where: { id: existing.id } });
    res.json({ success: true, data: null });
  }),
);

// نسخ كل مقاولي الأدمن لحساب مهندس دفعة واحدة (يتخطى الموجود بنفس الاسم)
adminRoutes.post(
  '/users/:userId/contractors/copy-mine',
  validate({ params: userIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = BigInt(req.params.userId);
    await assertUserExists(userId);
    const mine = await prisma.contractor.findMany({ where: { userId: req.user!.id } });
    const theirs = await prisma.contractor.findMany({ where: { userId }, select: { name: true } });
    const have = new Set(theirs.map((c) => c.name));
    const toCreate = mine.filter((c) => !have.has(c.name));
    if (toCreate.length) {
      await prisma.contractor.createMany({ data: toCreate.map((c) => ({ userId, name: c.name, spec: c.spec, rate: c.rate, rateType: c.rateType })) });
    }
    res.json({ success: true, data: { added: toCreate.length, skipped: mine.length - toCreate.length } });
  }),
);

// نسخ كل أماكن الأدمن لحساب مهندس دفعة واحدة (يتخطى الموجود بنفس الاسم) — الملاحظات بتتنسخ معاها
adminRoutes.post(
  '/users/:userId/places/copy-mine',
  validate({ params: userIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = BigInt(req.params.userId);
    await assertUserExists(userId);
    const mine = await prisma.place.findMany({ where: { userId: req.user!.id } });
    const theirs = await prisma.place.findMany({ where: { userId }, select: { name: true } });
    const have = new Set(theirs.map((p) => p.name));
    const toCreate = mine.filter((p) => !have.has(p.name));
    if (toCreate.length) {
      await prisma.place.createMany({ data: toCreate.map((p) => ({ userId, name: p.name, note: p.note })) });
    }
    res.json({ success: true, data: { added: toCreate.length, skipped: mine.length - toCreate.length } });
  }),
);

// ── إعدادات مستخدم معيّن (PIN hash + التوقيع) ──
adminRoutes.get(
  '/users/:userId/settings',
  validate({ params: userIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    await assertUserExists(BigInt(req.params.userId));
    const settings = await prisma.accountSettings.findUnique({ where: { userId: BigInt(req.params.userId) } });
    res.json({ success: true, data: serializeSettings(settings) });
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

// (M7) حالة آخر نسخة احتياطية — عشان الفشل ما يبقاش صامتًا في اللوجات بس
adminRoutes.get(
  '/backup-status',
  asyncHandler(async (_req: Request, res: Response) => {
    const row = await prisma.appConfig.findUnique({ where: { key: 'lastBackupStatus' } });
    res.json({ success: true, data: row?.value ? JSON.parse(row.value) : null });
  }),
);

// ── نسخة احتياطية فورية لقاعدة البيانات → Drive (يدوي — والجدولة اليومية تلقائية) ──
adminRoutes.post(
  '/backup-now',
  asyncHandler(async (_req: Request, res: Response) => {
    const r = await runBackupToDrive();
    if (!r.ok) throw AppError.validation('فشل النسخ الاحتياطي: ' + r.detail);
    res.json({ success: true, data: { detail: r.detail } });
  }),
);

// ── مستويات اعتمادات المديرين (أسماء المستويات بالترتيب) ──
adminRoutes.get(
  '/approval-levels',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ success: true, data: await getApprovalLevels() });
  }),
);
adminRoutes.put(
  '/approval-levels',
  validate({ body: z.object({ levels: z.array(z.string().trim().min(1).max(60)).min(1).max(6) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await setApprovalLevels(req.body.levels) });
  }),
);

// ── قائمة الوحدات المتاحة (للواجهة) ──
adminRoutes.get(
  '/modules',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        modules: ALL_MODULES.map((key) => ({ key, label: MODULE_LABELS[key], default: DEFAULT_MODULES.includes(key) })),
        features: ALL_FEATURES.map((f) => ({ key: f.key, label: f.label, group: f.group, default: (DEFAULT_FEATURES as readonly string[]).includes(f.key) })),
      },
    });
  }),
);

// ── إنشاء حساب مهندس (بديل register بتوكن الأدمن — نفس المنطق، مسار أوضح للواجهة) ──
adminRoutes.post(
  '/users',
  validate({ body: z.object({ email: z.string().email().max(190), password: z.string().min(8).max(128), enabledModules: z.array(z.enum(ALL_MODULES)).optional(), enabledFeatures: z.array(z.string()).optional(), role: z.enum(['ADMIN','ENGINEER']).optional(), title: z.string().trim().max(100).optional(), project: z.enum(['سكني', 'تجاري']).optional(), site: z.coerce.number().int().min(1).max(2).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await authService.register(req.body.email, req.body.password, req.user, req.body.role, req.body.title);
    const userId = BigInt(result.user.id);
    // الموقع/المشروع من فورم الإنشاء — بيتحددوا مع الحساب من أول لحظة (مش بس من شاشة التعديل)
    if (req.body.project !== undefined || req.body.site !== undefined) {
      await prisma.user.update({
        where: { id: userId },
        data: { ...(req.body.project !== undefined ? { project: req.body.project } : {}), ...(req.body.site !== undefined ? { site: req.body.site } : {}) },
      });
    }
    if (req.body.enabledModules || req.body.enabledFeatures) await upsertSettings(userId, { enabledModules: req.body.enabledModules, enabledFeatures: req.body.enabledFeatures }, [req.user!.id, userId]);
    res.status(201).json({ success: true, data: result.user });
  }),
);

// ── تعديل بيانات حساب: المسمى الوظيفي و/أو الصلاحية و/أو المشروع/الموقع ──
adminRoutes.patch(
  '/users/:userId',
  validate({ params: userIdParam, body: z.object({ title: z.string().trim().max(100).nullable().optional(), role: z.enum(['ADMIN', 'ENGINEER']).optional(), project: z.enum(['سكني', 'تجاري']).nullable().optional(), site: z.coerce.number().int().min(1).max(2).optional(), approvalLevel: z.string().trim().max(60).nullable().optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = BigInt(req.params.userId);
    await assertUserExists(userId);
    // حماية: الأدمن لا يقدر ينزّل نفسه لمهندس (عشان ما يقفلش الإدارة على نفسه)
    if (req.body.role === 'ENGINEER' && userId === req.user!.id) throw AppError.validation('لا يمكنك إزالة صلاحية الإدارة من حسابك أنت');
    const data = {
      ...(req.body.title !== undefined ? { title: req.body.title?.trim() || null } : {}),
      ...(req.body.role !== undefined ? { role: req.body.role } : {}),
      ...(req.body.project !== undefined ? { project: req.body.project } : {}),
      ...(req.body.site !== undefined ? { site: req.body.site } : {}),
      // مستوى الاعتماد — تعيين الحساب كمعتمد في مستوى معيّن (أو null = مش معتمد)
      ...(req.body.approvalLevel !== undefined ? { approvalLevel: req.body.approvalLevel?.trim() || null } : {}),
    };
    const u = await prisma.user.update({ where: { id: userId }, data, select: { id: true, email: true, role: true, title: true, project: true, site: true, approvalLevel: true } });
    // تغيير الصلاحية يُبطل جلسات الحساب (التوكن فيه الدور القديم)
    if (req.body.role !== undefined) await prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    res.json({ success: true, data: u });
  }),
);

// ── ملخص بيانات حساب (للعرض قبل الحذف) ──
adminRoutes.get(
  '/users/:userId/summary',
  validate({ params: userIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = BigInt(req.params.userId);
    await assertUserExists(userId);
    const w = { where: { userId } };
    const [records, contractors, places, todos, irRecords, execRecords, dailyRecords, files] = await Promise.all([
      prisma.record.count(w), prisma.contractor.count(w), prisma.place.count(w), prisma.todo.count(w),
      prisma.irRecord.count(w), prisma.execRecord.count(w), prisma.dailyRecord.count(w), prisma.file.count(w),
    ]);
    res.json({ success: true, data: { records, contractors, places, todos, irRecords, execRecords, dailyRecords, files } });
  }),
);

// ── حذف حساب نهائيًا مع كل بياناته ──
// حماية: لازم يبعت إيميل الحساب مطابقًا (تأكيد ثانٍ على السيرفر)، ولا يقدر يحذف نفسه، ولا آخر أدمن
adminRoutes.delete(
  '/users/:userId',
  validate({ params: userIdParam, body: z.object({ confirmEmail: z.string().email() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = BigInt(req.params.userId);
    const user = await assertUserExists(userId);
    if (userId === req.user!.id) throw AppError.validation('لا يمكنك حذف حسابك أنت من هنا');
    if (user.email.toLowerCase() !== req.body.confirmEmail.trim().toLowerCase()) throw AppError.validation('الإيميل غير مطابق — لم يتم الحذف');
    if (user.role === 'ADMIN') {
      const admins = await prisma.user.count({ where: { role: 'ADMIN' } });
      if (admins <= 1) throw AppError.validation('لا يمكن حذف آخر مدير نظام');
    }
    // ملفات التخزين (صور/توقيع) تُحذف من القرص؛ صفوف DB تُحذف cascade مع المستخدم
    const files = await prisma.file.findMany({ where: { userId }, select: { filePath: true } });
    for (const f of files) await storage.remove(f.filePath).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } });
    res.json({ success: true, data: { deleted: user.email, filesRemoved: files.length } });
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
