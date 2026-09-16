import { Router } from 'express';
import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { allWindowStates, WindowKind, writeWindowConfig } from '../services/windows';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { authenticate, requireRole } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { accountSettingsSchema, upsertSettings, serializeSettings } from '../controllers/account.controller';
import { ALL_MODULES, DEFAULT_MODULES, MODULE_LABELS, ALL_FEATURES, DEFAULT_FEATURES } from '../utils/modules';
import { authService } from '../services/auth.service';
import { placeCreateSchema, contractorCreateSchema, contractorUpdateSchema } from '../schema/entities.schema';
import { checkAndSyncPlaceSite, assertProjectExists, readSiteNames, listProjects, SITE_NAME_DEFAULTS } from '../services/placeSite';
export { readSiteNames };
import { arabizeRateTypes, toEnum, RateTypeAr } from '../utils/rateType';
import { storage } from '../services/storage';
import { runBackupToDrive } from '../services/backup';
import { GRADES, APPROVING_GRADES, isValidGrade, requiredLevelsFor, soleProjectManagerId, getApprovalMatrix, setApprovalMatrix } from '../services/approvalChain';

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

adminRoutes.get(
  '/config',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ success: true, data: { ...(await readSiteNames()), projects: await listProjects() } });
  }),
);

// site1Name/site2Name (توافقي) بيعدّلوا اسمي المشروعين 1 و2 في جدول projects نفسه
adminRoutes.patch(
  '/config',
  validate({ body: z.object({ site1Name: z.string().trim().min(1).max(60).optional(), site2Name: z.string().trim().min(1).max(60).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const entries = Object.entries(req.body as Record<string, string>).filter(([k]) => k in SITE_NAME_DEFAULTS);
    for (const [key, value] of entries) {
      const id = key === 'site1Name' ? 1 : 2;
      await prisma.project.upsert({ where: { id }, update: { name: value }, create: { id, name: value } });
    }
    res.json({ success: true, data: { ...(await readSiteNames()), projects: await listProjects() } });
  }),
);

// ── المشاريع (إضافة/إعادة تسمية — 1 و2 بيحتفظوا بالـid والاسم القديم لحد ما الأدمن يغيّره) ──
adminRoutes.get(
  '/projects',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ success: true, data: await listProjects() });
  }),
);

const projectNameSchema = z.object({ name: z.string().trim().min(1, 'اكتب اسم المشروع').max(120) });

adminRoutes.post(
  '/projects',
  validate({ body: projectNameSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prisma.project.findUnique({ where: { name: req.body.name } });
    if (existing) throw AppError.conflict('فيه مشروع بنفس الاسم بالفعل');
    const project = await prisma.project.create({ data: { name: req.body.name } });
    res.status(201).json({ success: true, data: project });
  }),
);

adminRoutes.patch(
  '/projects/:id',
  validate({ params: z.object({ id: z.coerce.number().int() }), body: projectNameSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    await assertProjectExists(id);
    const existing = await prisma.project.findFirst({ where: { name: req.body.name, id: { not: id } } });
    if (existing) throw AppError.conflict('فيه مشروع بنفس الاسم بالفعل');
    const project = await prisma.project.update({ where: { id }, data: { name: req.body.name } });
    res.json({ success: true, data: project });
  }),
);

// ── المشاريع المحمّلة على حساب مهندس (بمعتمديها الخاصين) ──
const userProjectSerialize = (up: { id: bigint; projectId: number; approverTlId: bigint | null; approverCmId: bigint | null; approverPmId: bigint | null }, name: string) => ({
  projectId: up.projectId,
  name,
  approverTlId: up.approverTlId?.toString() ?? null,
  approverCmId: up.approverCmId?.toString() ?? null,
  approverPmId: up.approverPmId?.toString() ?? null,
});

adminRoutes.get(
  '/users/:userId/projects',
  validate({ params: userIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = BigInt(req.params.userId);
    await assertUserExists(userId);
    const rows = await prisma.userProject.findMany({ where: { userId }, orderBy: { projectId: 'asc' } });
    const projects = await listProjects();
    const nameOf = (id: number) => projects.find((p) => p.id === id)?.name ?? 'مشروع ' + id;
    res.json({ success: true, data: rows.map((r) => userProjectSerialize(r, nameOf(r.projectId))) });
  }),
);

const userProjectBodySchema = z.object({
  approverTlId: z.coerce.bigint().nullable().optional(),
  approverCmId: z.coerce.bigint().nullable().optional(),
  approverPmId: z.coerce.bigint().nullable().optional(),
});

adminRoutes.put(
  '/users/:userId/projects/:projectId',
  validate({ params: z.object({ userId: z.coerce.bigint(), projectId: z.coerce.number().int() }), body: userProjectBodySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = BigInt(req.params.userId);
    const projectId = Number(req.params.projectId);
    await assertUserExists(userId);
    await assertProjectExists(projectId);
    // المعتمد المسند لازم يكون درجته هي نفس المستوى (وميكونش الحساب نفسه) — نفس التحقق زي PATCH /users/:userId
    for (const [field, level] of [['approverTlId', 'team leader'], ['approverCmId', 'construction manager'], ['approverPmId', 'project manager']] as const) {
      const val = req.body[field] as bigint | null | undefined;
      if (val === undefined || val === null) continue;
      if (val === userId) throw AppError.validation('الحساب لا يقدر يعتمد لنفسه');
      const a = await prisma.user.findUnique({ where: { id: val }, select: { grade: true } });
      if (!a) throw AppError.validation('المعتمد المختار غير موجود');
      if (a.grade !== level) throw AppError.validation(`المعتمد المختار مش درجته "${level}"`);
    }
    const data = {
      ...(req.body.approverTlId !== undefined ? { approverTlId: req.body.approverTlId } : {}),
      ...(req.body.approverCmId !== undefined ? { approverCmId: req.body.approverCmId } : {}),
      ...(req.body.approverPmId !== undefined ? { approverPmId: req.body.approverPmId } : {}),
    };
    // أول تحميل للمشروع على الحساب: المعتمدين بيبدأوا بمعتمدي الحساب الحاليين (مش فاضيين) —
    // تحميل مشروع (خصوصًا جريني الافتراضي) مايشيلش المعتمدين الحاليين، والأدمن بيغيّر المختلف بس
    const current = await prisma.user.findUnique({ where: { id: userId }, select: { approverTlId: true, approverCmId: true, approverPmId: true } });
    const up = await prisma.userProject.upsert({
      where: { userId_projectId: { userId, projectId } },
      update: data,
      create: { userId, projectId, approverTlId: current?.approverTlId ?? null, approverCmId: current?.approverCmId ?? null, approverPmId: current?.approverPmId ?? null, ...data },
    });
    const name = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    res.json({ success: true, data: userProjectSerialize(up, name?.name ?? 'مشروع ' + projectId) });
  }),
);

adminRoutes.delete(
  '/users/:userId/projects/:projectId',
  validate({ params: z.object({ userId: z.coerce.bigint(), projectId: z.coerce.number().int() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = BigInt(req.params.userId);
    const projectId = Number(req.params.projectId);
    await prisma.userProject.deleteMany({ where: { userId, projectId } });
    res.json({ success: true, data: null });
  }),
);

// ── مواعيد الإرسال والاعتماد ──
// القراءة للكل من GET /api/windows — هنا التعديل بس (الراوتر كله محمي بـ requireRole('ADMIN'))
const windowEdgeSchema = z.object({ day: z.coerce.number().int().min(0).max(6), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) });
const windowCfgSchema = z.object({
  enabled: z.boolean(),
  windows: z.array(z.object({ from: windowEdgeSchema, to: windowEdgeSchema })).min(1).max(7),
  openUntil: z.string().datetime().nullable().optional(),
});
adminRoutes.patch(
  '/windows',
  validate({ body: z.object({ submit: windowCfgSchema.optional(), approve: windowCfgSchema.optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    for (const kind of ['submit', 'approve'] as WindowKind[]) {
      if (body[kind] !== undefined) await writeWindowConfig(kind, body[kind]);
    }
    res.json({ success: true, data: await allWindowStates(), serverNow: new Date().toISOString() });
  }),
);

// ── قائمة المستخدمين ──
adminRoutes.get(
  '/users',
  asyncHandler(async (_req: Request, res: Response) => {
    const users = await prisma.user.findMany({
      select: {
        id: true, email: true, displayName: true, role: true, title: true, project: true, site: true, grade: true, lastSeenAt: true, createdAt: true,
        approverTlId: true, approverCmId: true, approverPmId: true,
        syncLocalRecords: true, syncUnsynced: true, syncReportedAt: true,
      },
      orderBy: { id: 'asc' },
    });
    // المستويات المطلوبة لدرجة الحساب واللي لسه مالهاش معتمد مسند — تحذير في كارت الحساب
    const solePm = await soleProjectManagerId();
    const FIELD = { 'team leader': 'approverTlId', 'construction manager': 'approverCmId', 'project manager': 'approverPmId' } as const;
    const missingFor = (u: (typeof users)[number]) =>
      requiredLevelsFor(u.grade).filter((lv) => {
        const id = u[FIELD[lv as keyof typeof FIELD]];
        if (id) return false;
        return !(lv === 'project manager' && solePm);
      });
    // عدد السراكي المسجلة على السيرفر لكل حساب (استعلام واحد مجمّع)
    const counts = await prisma.record.groupBy({ by: ['userId'], _count: { _all: true } });
    const byUser = new Map(counts.map((c) => [c.userId.toString(), c._count._all]));
    res.json({ success: true, data: users.map((u) => ({ ...u, recordsCount: byUser.get(u.id.toString()) ?? 0, missingApprovers: missingFor(u) })) });
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
    await checkAndSyncPlaceSite(req.body.name, req.body.site ?? 1);
    const place = await prisma.place.create({ data: { userId: BigInt(req.params.userId), name: req.body.name, note: req.body.note?.trim() || null, site: req.body.site ?? 1 } });
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
    // الاسم ممكن يتغير من غير ما المشروع يتبعت — checkAndSyncPlaceSite بيتحقق بالمشروع الفعلي بعد التعديل
    const siteVal = req.body.site === null ? 1 : req.body.site;
    await checkAndSyncPlaceSite(req.body.name, siteVal, existing);
    const place = await prisma.place.update({
      where: { id: existing.id },
      data: {
        name: req.body.name,
        ...(req.body.note !== undefined ? { note: req.body.note?.trim() || null } : {}),
        ...(siteVal !== undefined ? { site: siteVal } : {}),
      },
    });
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
    for (const p of toCreate) await checkAndSyncPlaceSite(p.name, p.site ?? 1);
    if (toCreate.length) {
      await prisma.place.createMany({ data: toCreate.map((p) => ({ userId, name: p.name, note: p.note, site: p.site ?? 1 })) });
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

// ── الدرجات ومستويات الاعتماد (ثابتة في الكود) + قوائم المعتمدين المتاحين لكل مستوى ──
adminRoutes.get(
  '/approval-levels',
  asyncHandler(async (_req: Request, res: Response) => {
    const approvers = await prisma.user.findMany({
      where: { grade: { in: [...APPROVING_GRADES] } },
      select: { id: true, email: true, displayName: true, title: true, grade: true },
      orderBy: { email: 'asc' },
    });
    res.json({
      success: true,
      data: {
        grades: [...GRADES],
        levels: [...APPROVING_GRADES],
        // مين بيعتمد لمين — للعرض في شاشة الإدارة
        matrix: getApprovalMatrix(),
        approvers,
        solePmId: (await soleProjectManagerId())?.toString() ?? null,
      },
    });
  }),
);

// ── سجل نشاط حساب (دخول/مزامنة/أخطاء) — لتشخيص مشاكل المهندسين من كارت الحساب ──
adminRoutes.get(
  '/activity',
  validate({ query: z.object({ userId: z.coerce.bigint().optional(), email: z.string().max(190).optional(), limit: z.coerce.number().int().min(1).max(200).optional().default(60) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { userId?: bigint; email?: string; limit: number };
    const rows = await prisma.activityLog.findMany({
      where: q.userId ? { userId: q.userId } : q.email ? { email: q.email } : {},
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    res.json({ success: true, data: rows.map((r) => ({ ...r, id: r.id.toString(), userId: r.userId?.toString() ?? null })) });
  }),
);

// ── ملخص نشاط كل الحسابات (جدول واحد) — الحسابات كلها حتى اللي مالهاش نشاط ──
// استعلامان مجمّعان بس (مش استعلام لكل حساب): groupBy للعدادات + آخر سطر لكل حدث.
adminRoutes.get(
  '/activity/summary',
  validate({ query: z.object({ days: z.coerce.number().int().min(1).max(60).optional().default(7) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const days = (req.query as unknown as { days: number }).days;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const users = await prisma.user.findMany({
      select: {
        id: true, email: true, displayName: true, title: true, grade: true, site: true, lastSeenAt: true, createdAt: true,
        syncLocalRecords: true, syncUnsynced: true, syncReportedAt: true,
        accountSettings: { select: { enabledModules: true } },
      },
      orderBy: { email: 'asc' },
    });

    const logs = await prisma.activityLog.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      select: { userId: true, email: true, event: true, detail: true, status: true, path: true, createdAt: true },
      take: 20000,
    });

    type Agg = {
      loginOk: number; loginFail: number; sync: number; errors: number;
      lastLoginOk: Date | null; lastLoginFail: Date | null; lastSync: Date | null;
      lastFailDetail: string | null; lastSyncDetail: string | null;
      // أكثر خطأ متكرر (status+path) وآخر مرة حصل فيها
      errTop: { status: number | null; path: string | null; detail: string | null; count: number; at: Date } | null;
    };
    const byUser = new Map<string, Agg>();
    const errCount = new Map<string, { status: number | null; path: string | null; detail: string | null; count: number; at: Date }>();
    const keyOf = (l: { userId: bigint | null; email: string }) => (l.userId ? 'u' + l.userId.toString() : 'e' + l.email);

    for (const l of logs) {
      const k = keyOf(l);
      let a = byUser.get(k);
      if (!a) {
        a = { loginOk: 0, loginFail: 0, sync: 0, errors: 0, lastLoginOk: null, lastLoginFail: null, lastSync: null, lastFailDetail: null, lastSyncDetail: null, errTop: null };
        byUser.set(k, a);
      }
      // اللوجات مرتبة من الأحدث، فأول ما نشوف حدث بيبقى هو الأحدث
      if (l.event === 'LOGIN_OK') { a.loginOk++; if (!a.lastLoginOk) a.lastLoginOk = l.createdAt; }
      else if (l.event === 'LOGIN_FAIL') { a.loginFail++; if (!a.lastLoginFail) { a.lastLoginFail = l.createdAt; a.lastFailDetail = l.detail; } }
      else if (l.event === 'SYNC') { a.sync++; if (!a.lastSync) { a.lastSync = l.createdAt; a.lastSyncDetail = l.detail; } }
      else if (l.event === 'API_ERR') {
        a.errors++;
        const ek = k + '|' + l.status + '|' + l.path;
        const cur = errCount.get(ek);
        if (cur) cur.count++;
        else errCount.set(ek, { status: l.status, path: l.path, detail: l.detail, count: 1, at: l.createdAt });
      }
    }
    // أكثر خطأ متكرر لكل حساب
    for (const [ek, v] of errCount) {
      const k = ek.split('|')[0];
      const a = byUser.get(k);
      if (a && (!a.errTop || v.count > a.errTop.count)) a.errTop = v;
    }

    const empty = (): Agg => ({ loginOk: 0, loginFail: 0, sync: 0, errors: 0, lastLoginOk: null, lastLoginFail: null, lastSync: null, lastFailDetail: null, lastSyncDetail: null, errTop: null });
    // ⚠ محاولات الدخول الفاشلة بتتسجل بالإيميل بس (مفيش userId وقتها) — فلازم ندمج المفتاحين،
    // وإلا فشل الدخول لحساب موجود ما بيظهرش في الملخص خالص (وهو أهم عمود فيه).
    const merge = (a: Agg, b: Agg | undefined): Agg => {
      if (!b) return a;
      const newer = (x: Date | null, y: Date | null) => (!x ? y : !y ? x : x > y ? x : y);
      return {
        loginOk: a.loginOk + b.loginOk, loginFail: a.loginFail + b.loginFail,
        sync: a.sync + b.sync, errors: a.errors + b.errors,
        lastLoginOk: newer(a.lastLoginOk, b.lastLoginOk),
        lastLoginFail: newer(a.lastLoginFail, b.lastLoginFail),
        lastSync: newer(a.lastSync, b.lastSync),
        lastFailDetail: (a.lastLoginFail && (!b.lastLoginFail || a.lastLoginFail > b.lastLoginFail)) ? a.lastFailDetail : b.lastFailDetail,
        lastSyncDetail: (a.lastSync && (!b.lastSync || a.lastSync > b.lastSync)) ? a.lastSyncDetail : b.lastSyncDetail,
        errTop: !a.errTop ? b.errTop : !b.errTop ? a.errTop : (b.errTop.count > a.errTop.count ? b.errTop : a.errTop),
      };
    };
    const data = users.map((u) => {
      const a = merge(byUser.get('u' + u.id.toString()) ?? empty(), byUser.get('e' + u.email));
      const mods = (u.accountSettings?.enabledModules as string[] | null) ?? null;
      return {
        id: u.id.toString(),
        email: u.email,
        // (9 سبتمبر 2026) كان منسي: مختار في الـ select فوق لكن مش مترجّع هنا،
        // فجدول "نشاط الحسابات" كان بيوقع لـ personName() على أول الإيميل بدل الاسم العربي
        displayName: u.displayName,
        title: u.title,
        grade: u.grade,
        site: u.site,
        lastSeenAt: u.lastSeenAt,
        createdAt: u.createdAt,
        // الحساب المعتمد بس (بلا وحدة السراكي) مالوش مزامنة أصلًا — الواجهة بتستخدمها في الترجمة
        hasRecords: mods === null || mods.includes('records'),
        syncLocalRecords: u.syncLocalRecords,
        syncUnsynced: u.syncUnsynced,
        syncReportedAt: u.syncReportedAt,
        ...a,
      };
    });
    res.json({ success: true, days, data });
  }),
);

// ── مصفوفة "مين يعتمد لمين" (قابلة للتعديل من شاشة الإدارة) ──
// الترتيب بيتفرض دايمًا بترتيب السلم مهما كان ترتيب الاختيار (normalizeChain في الخدمة).
adminRoutes.get(
  '/approval-matrix',
  asyncHandler(async (_req: Request, res: Response) => {
    // عدد الكشوف اللي لسه في المراجعة — الواجهة بتحذر بيه قبل الحفظ
    const inReview = await prisma.submission.count({ where: { reviewState: 'IN_REVIEW' } });
    res.json({ success: true, data: { grades: [...GRADES], levels: [...APPROVING_GRADES], matrix: getApprovalMatrix(), inReview } });
  }),
);
adminRoutes.put(
  '/approval-matrix',
  validate({ body: z.object({ matrix: z.record(z.string(), z.array(z.string())) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const saved = await setApprovalMatrix(req.body.matrix as Record<string, unknown>);
    res.json({ success: true, data: saved });
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
  validate({ params: userIdParam, body: z.object({ displayName: z.string().trim().max(120).nullable().optional(), title: z.string().trim().max(100).nullable().optional(), role: z.enum(['ADMIN', 'ENGINEER']).optional(), project: z.enum(['سكني', 'تجاري']).nullable().optional(), site: z.coerce.number().int().min(1).max(2).optional(), grade: z.string().trim().max(60).optional(), approverTlId: z.coerce.bigint().nullable().optional(), approverCmId: z.coerce.bigint().nullable().optional(), approverPmId: z.coerce.bigint().nullable().optional() }) }),
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
      // الدرجة — بتحدد مين بيعتمد له، وبتخليه معتمدًا لو من الدرجات التلاتة الأعلى
      ...(req.body.grade !== undefined ? { grade: req.body.grade } : {}),
      ...(req.body.displayName !== undefined ? { displayName: req.body.displayName || null } : {}),
      // المعتمدون المسندون — null = يتشال الإسناد (المستوى يتخطى في سلسلته)
      ...(req.body.approverTlId !== undefined ? { approverTlId: req.body.approverTlId } : {}),
      ...(req.body.approverCmId !== undefined ? { approverCmId: req.body.approverCmId } : {}),
      ...(req.body.approverPmId !== undefined ? { approverPmId: req.body.approverPmId } : {}),
    };
    if (req.body.grade !== undefined && !isValidGrade(req.body.grade)) throw AppError.validation('درجة غير معروفة');
    // المعتمد المسند لازم يكون درجته هي نفس المستوى (وميكونش الحساب نفسه)
    for (const [field, level] of [['approverTlId', 'team leader'], ['approverCmId', 'construction manager'], ['approverPmId', 'project manager']] as const) {
      const val = req.body[field] as bigint | null | undefined;
      if (val === undefined || val === null) continue;
      if (val === userId) throw AppError.validation('الحساب لا يقدر يعتمد لنفسه');
      const a = await prisma.user.findUnique({ where: { id: val }, select: { grade: true } });
      if (!a) throw AppError.validation('المعتمد المختار غير موجود');
      if (a.grade !== level) throw AppError.validation(`المعتمد المختار مش درجته "${level}"`);
    }
    const u = await prisma.user.update({ where: { id: userId }, data, select: { id: true, email: true, displayName: true, role: true, title: true, project: true, site: true, grade: true, approverTlId: true, approverCmId: true, approverPmId: true } });
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
