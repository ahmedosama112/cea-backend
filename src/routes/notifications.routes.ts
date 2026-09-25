import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middlewares/validate';
import { idParamSchema } from '../utils/crudFactory';
import { enabledModulesFor } from '../middlewares/moduleGuard';
import { APPROVING_GRADES, GRADES } from '../services/approvalChain';

// ═══════════ التنبيهات الداخلية (جرس الهيدر + تاب "التنبيهات" للأدمن) ═══════════
// السيرفر بيخزّن **تعريف** التنبيه بس (العنوان + الجدولة + المستقبلين) — مش كل ظهور على حدة.
// الواجهة بتحسب مواعيد الظهور من الجدولة على الجهاز، فالجرس شغال حتى أوفلاين من الكاش المحلي.
// (authenticate مطبّق في routes/index.ts — بلا requireModule: الجرس متاح لأي حساب)

export const notificationsRoutes = Router();

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
// تاريخ نصي YYYY-MM-DD → Date عند منتصف ليل UTC (نفس أسلوب باقي حقول @db.Date في المشروع)
const toDate = (s: string | null | undefined) => (s ? new Date(s + 'T00:00:00.000Z') : null);

function requireAdmin(req: Request) {
  if (req.user!.role !== 'ADMIN') throw AppError.forbidden('التنبيهات بيضيفها الأدمن فقط');
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ غير صحيح');
const bodySchema = z.object({
  title: z.string().trim().min(1, 'اكتب عنوان التنبيه').max(120),
  body: z.string().trim().max(500).optional().default(''),
  icon: z.string().trim().max(12).optional().default(''),
  level: z.enum(['info', 'warn', 'urgent']).optional().default('info'),
  schedule: z.enum(['once', 'daily', 'weekly', 'monthly']),
  onceDate: dateStr.nullish(),
  // "2" أو "0,2,4" — 0=الأحد … 6=السبت
  weekdays: z.array(z.coerce.number().int().min(0).max(6)).optional().default([]),
  monthDay: z.coerce.number().int().min(1).max(31).nullish(),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'وقت غير صحيح').optional().default('08:00'),
  leadDays: z.coerce.number().int().min(0).max(30).optional().default(0),
  startDate: dateStr.nullish(),
  endDate: dateStr.nullish(),
  active: z.boolean().optional().default(true),
  audience: z.enum(['me', 'all', 'site', 'grade', 'users']),
  audienceSite: z.coerce.number().int().min(1).max(2).nullish(),
  audienceGrade: z.enum(GRADES).nullish(),
  linkTab: z.string().trim().max(30).optional().default(''),
  userIds: z.array(z.coerce.bigint()).optional().default([]),
});

// تحقق منطقي: كل نوع جدولة له حقوله، وكل نوع مستقبلين له هدفه
function checkShape(b: z.infer<typeof bodySchema>) {
  if (b.schedule === 'once' && !b.onceDate) throw AppError.validation('اختار تاريخ التنبيه');
  if (b.schedule === 'weekly' && b.weekdays.length === 0) throw AppError.validation('اختار يوم واحد على الأقل في الأسبوع');
  if (b.schedule === 'monthly' && !b.monthDay) throw AppError.validation('اختار يوم الشهر');
  if (b.audience === 'site' && !b.audienceSite) throw AppError.validation('اختار الموقع');
  if (b.audience === 'grade' && !b.audienceGrade) throw AppError.validation('اختار الدرجة');
  if (b.audience === 'users' && b.userIds.length === 0) throw AppError.validation('اختار حساب واحد على الأقل');
  if (b.startDate && b.endDate && b.startDate > b.endDate) throw AppError.validation('تاريخ البداية بعد تاريخ النهاية');
}

function toData(b: z.infer<typeof bodySchema>) {
  return {
    title: b.title,
    body: b.body || null,
    icon: b.icon || null,
    level: b.level,
    schedule: b.schedule,
    onceDate: b.schedule === 'once' ? toDate(b.onceDate) : null,
    weekdays: b.schedule === 'weekly' ? [...new Set(b.weekdays)].sort().join(',') : null,
    monthDay: b.schedule === 'monthly' ? (b.monthDay ?? null) : null,
    timeOfDay: b.timeOfDay,
    leadDays: b.leadDays,
    startDate: toDate(b.startDate),
    endDate: toDate(b.endDate),
    active: b.active,
    audience: b.audience,
    audienceSite: b.audience === 'site' ? (b.audienceSite ?? null) : null,
    audienceGrade: b.audience === 'grade' ? (b.audienceGrade ?? null) : null,
    linkTab: b.linkTab || null,
  };
}

type Row = Record<string, unknown> & { onceDate: Date | null; startDate: Date | null; endDate: Date | null; weekdays: string | null; targets?: { userId: bigint }[] };
// الصف زي ما الواجهة بتفهمه: تواريخ نصية، أيام الأسبوع مصفوفة أرقام، والمستقبلون قائمة ids
function shape(n: Row): Record<string, unknown> {
  const { targets, ...rest } = n;
  return {
    ...rest,
    onceDate: ymd(n.onceDate),
    startDate: ymd(n.startDate),
    endDate: ymd(n.endDate),
    weekdays: n.weekdays ? n.weekdays.split(',').map(Number) : [],
    userIds: (targets ?? []).map((t) => t.userId.toString()),
  };
}

// ── قائمتي: التنبيهات الموجّهة لي (تعريفات) + "تم" بتاعتي + التنبيهات التلقائية ──
notificationsRoutes.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const myId = req.user!.id;
    const me = await prisma.user.findUnique({ where: { id: myId }, select: { site: true, grade: true } });
    // اليوم بتوقيت UTC — التنبيه اللي خلص أمس مش لازم يتبعت (الحساب النهائي للظهور بيتم على الجهاز بتوقيته)
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
    const rows = await prisma.notification.findMany({
      where: {
        active: true,
        OR: [
          { audience: 'all' },
          { audience: 'me', createdById: myId },
          { audience: 'site', audienceSite: me?.site ?? 1 },
          { audience: 'grade', audienceGrade: me?.grade ?? 'junior' },
          { audience: 'users', targets: { some: { userId: myId } } },
        ],
        AND: [{ OR: [{ endDate: null }, { endDate: { gte: today } }] }],
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    // "تم" آخر 60 يوم بس — القديم ما بيتعرضش أصلًا
    const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const reads = await prisma.notificationRead.findMany({
      where: { userId: myId, occurrence: { gte: since }, notificationId: { in: rows.map((r) => r.id) } },
      select: { notificationId: true, occurrence: true },
    });
    const doneMap = new Map<string, string[]>();
    for (const r of reads) {
      const k = r.notificationId.toString();
      doneMap.set(k, [...(doneMap.get(k) ?? []), r.occurrence]);
    }

    res.json({
      success: true,
      data: {
        notifications: rows.map((n) => ({ ...shape(n), done: doneMap.get(n.id.toString()) ?? [] })),
        auto: await autoAlerts(req),
        serverTime: new Date().toISOString(),
      },
    });
  }),
);

// ── التنبيهات التلقائية: النظام بيحسبها من البيانات (مفيش إدخال من الأدمن) ──
// المهام المتأخرة بتتحسب في الواجهة من نسخة الجهاز (بتوقيت الجهاز) — هنا اللي محتاج السيرفر بس.
async function autoAlerts(req: Request) {
  const myId = req.user!.id;
  const isAdmin = req.user!.role === 'ADMIN';
  const modules = isAdmin ? null : await enabledModulesFor(myId);
  const has = (m: string) => isAdmin || (modules ?? []).some((x) => x === m);
  const out: Record<string, unknown> = {};

  // 1) كشوف مستنية اعتمادي (نفس شرط canAct في طابور الاعتمادات)
  if (has('approvals')) {
    const me = await prisma.user.findUnique({ where: { id: myId }, select: { grade: true } });
    const isApprover = !!me?.grade && (APPROVING_GRADES as readonly string[]).includes(me.grade);
    const where: Prisma.SubmissionWhereInput = {
      reviewState: 'IN_REVIEW',
      queueHiddenAt: null,
      OR: [
        { currentApproverId: myId },
        ...(isApprover ? [{ currentApproverId: null, currentLevel: me!.grade }] : []),
      ],
    };
    const count = await prisma.submission.count({ where });
    if (count > 0) {
      // keys: بصمة كل كشف مستحق — الواجهة بتقارنها بـ«مش دلوقتي» عشان التنبيه يرجع بس لو فيه كشف جديد فعلًا
      const pending = await prisma.submission.findMany({
        where, orderBy: { createdAt: 'asc' }, take: 200,
        select: { id: true, revision: true, currentLevel: true, createdAt: true },
      });
      out.approvals = {
        count,
        since: pending[0]?.createdAt.toISOString() ?? null,
        keys: pending.map((s) => `${s.id}:${s.revision}:${s.currentLevel ?? ''}`),
      };
    }
  }

  // 2) كشوفي المرفوضة اللي لسه ما اتبعتتش تاني (reviewState = RETURNED)
  if (has('submissions')) {
    const rows = await prisma.submission.findMany({
      where: { userId: myId, reviewState: 'RETURNED' },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: {
        id: true, contractorName: true, weekStart: true, revision: true,
        reviews: { where: { decision: 'REJECTED' }, orderBy: { createdAt: 'desc' }, take: 1, select: { note: true, level: true } },
      },
    });
    if (rows.length) {
      out.rejected = {
        count: rows.length,
        items: rows.map((r) => ({
          id: r.id.toString(),
          revision: r.revision,
          contractorName: r.contractorName,
          weekStart: ymd(r.weekStart),
          note: r.reviews[0]?.note ?? '',
          level: r.reviews[0]?.level ?? '',
        })),
      };
    }
  }
  // 3) النسخة الاحتياطية اليومية — للأدمن بس: فاشلة، أو ما اتسجلتش، أو أقدم من 36 ساعة.
  // (النسخة بتتاخد بعد الساعة 3 فجرًا UTC، فـ36 ساعة معناها إن نسخة يوم كامل فاتت.)
  if (isAdmin) {
    const row = await prisma.appConfig.findUnique({ where: { key: 'lastBackupStatus' } }).catch(() => null);
    type BackupStatus = { at?: string; ok?: boolean; detail?: string };
    let st: BackupStatus | null = null;
    try { st = row?.value ? (JSON.parse(row.value) as BackupStatus) : null; } catch { st = null; }
    const atMs = st?.at ? Date.parse(st.at) : NaN;
    const stale = !Number.isFinite(atMs) || Date.now() - atMs > 36 * 60 * 60 * 1000;
    if (!st || st.ok !== true || stale) {
      out.backup = { ok: st?.ok === true, at: st?.at ?? null, detail: st?.detail ?? '', stale };
    }
  }
  return out;
}

// ── "تم" على ظهور بعينه (occurrence = تاريخ الظهور) ──
const occSchema = z.object({ occurrence: dateStr });
notificationsRoutes.post(
  '/:id/done',
  validate({ params: idParamSchema, body: occSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = BigInt(req.params.id);
    const occurrence = req.body.occurrence as string;
    const n = await prisma.notification.findUnique({ where: { id }, select: { id: true } });
    if (!n) throw AppError.notFound('التنبيه غير موجود');
    await prisma.notificationRead.upsert({
      where: { notificationId_userId_occurrence: { notificationId: id, userId: req.user!.id, occurrence } },
      update: { doneAt: new Date() },
      create: { notificationId: id, userId: req.user!.id, occurrence },
    });
    res.json({ success: true });
  }),
);

notificationsRoutes.post(
  '/:id/undone',
  validate({ params: idParamSchema, body: occSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await prisma.notificationRead.deleteMany({
      where: { notificationId: BigInt(req.params.id), userId: req.user!.id, occurrence: req.body.occurrence as string },
    });
    res.json({ success: true });
  }),
);

// ══ إدارة التنبيهات — الأدمن فقط ══

notificationsRoutes.get(
  '/manage',
  asyncHandler(async (req: Request, res: Response) => {
    requireAdmin(req);
    const rows = await prisma.notification.findMany({
      orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
      include: { targets: { select: { userId: true } }, createdBy: { select: { email: true, displayName: true } } },
    });
    res.json({ success: true, data: rows.map(shape) });
  }),
);

notificationsRoutes.post(
  '/manage',
  validate({ body: bodySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    requireAdmin(req);
    const b = req.body as z.infer<typeof bodySchema>;
    checkShape(b);
    const created = await prisma.notification.create({
      data: {
        ...toData(b),
        createdById: req.user!.id,
        targets: b.audience === 'users' ? { create: b.userIds.map((userId) => ({ userId })) } : undefined,
      },
      include: { targets: { select: { userId: true } } },
    });
    res.status(201).json({ success: true, data: shape(created) });
  }),
);

notificationsRoutes.patch(
  '/manage/:id',
  validate({ params: idParamSchema, body: bodySchema.partial().extend({ active: z.boolean().optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    requireAdmin(req);
    const id = BigInt(req.params.id);
    const current = await prisma.notification.findUnique({ where: { id }, include: { targets: { select: { userId: true } } } });
    if (!current) throw AppError.notFound('التنبيه غير موجود');
    // التعديل الجزئي بيتدمج مع الحالي ثم يتحقق ككل — عشان تبديل نوع الجدولة ما يسيبش حقول متناقضة
    // (بنشيل مفاتيح الـ undefined قبل الدمج عشان حقل ناقص في الطلب ما يمسحش قيمته الحالية)
    const patch = Object.fromEntries(Object.entries(req.body as Record<string, unknown>).filter(([, v]) => v !== undefined));
    const merged = bodySchema.parse({
      ...shape(current),
      body: current.body ?? '',
      icon: current.icon ?? '',
      linkTab: current.linkTab ?? '',
      userIds: current.targets.map((t) => t.userId.toString()),
      ...patch,
    });
    checkShape(merged);
    const updated = await prisma.$transaction(async (tx) => {
      await tx.notificationTarget.deleteMany({ where: { notificationId: id } });
      if (merged.audience === 'users') {
        await tx.notificationTarget.createMany({ data: merged.userIds.map((userId) => ({ notificationId: id, userId })) });
      }
      return tx.notification.update({ where: { id }, data: toData(merged), include: { targets: { select: { userId: true } } } });
    });
    res.json({ success: true, data: shape(updated) });
  }),
);

notificationsRoutes.delete(
  '/manage/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    requireAdmin(req);
    const id = BigInt(req.params.id);
    const found = await prisma.notification.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw AppError.notFound('التنبيه غير موجود');
    await prisma.notification.delete({ where: { id } });
    res.json({ success: true });
  }),
);
