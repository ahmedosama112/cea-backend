import { correctionList } from './corrections.routes';
import { classified, returned, completed, lockSubmission, workbook } from '../services/corrections';
import { validateWorkbook } from '../services/workbookSafety';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middlewares/validate';
import { requireWindow } from '../middlewares/windowGuard';
import { idParamSchema } from '../utils/crudFactory';
import { getApprovalLevels, CHAIN_LEVELS, SENIOR_LEVEL, isApproverGrade, buildChain, nextLevel, resolveChainForUser, soleProjectManagerId, pushSubmissionToSheet, prepareApprovalAccounting, signedFileBuffer, ChainUser, ChainSlot } from '../services/approvalChain';
import { countDataRows, dataRowsOf, readLaborRow } from '../services/rowReject';
import { storage } from '../services/storage';
import { listProjects } from '../services/placeSite';

// ═══════════ اعتمادات المديرين — تبويب المراجعة والاعتماد ═══════════
// (authenticate + requireModule('approvals') مطبّقين في routes/index.ts)


// (أمان — فحص نوفمبر 2026) دور الاعتماد بيتحسب من السلسلة الحالية، مش من currentApproverId المتخزّن لوحده:
// لو الأدمن غيّر المعتمد المسند للمستوى أو نزّل درجته، القديم يفقد الدور والجديد ياخده.
//  - كشف قديم من قبل الإسناد (currentApproverId = null): أي معتمد درجته = المستوى (السلوك القديم)
//  - المستوى الحالي خرج من السلسلة خالص (stuck): نفس السلوك القديم — الاعتماد بيترفض بعدين والأدمن بيفكّه
//  - غير كده: لازم يكون هو المسند للمستوى ده في السلسلة الحالية ودرجته لسه = المستوى
function isMyTurn(sub: { currentLevel: string | null; currentApproverId: bigint | null }, chain: ChainSlot[], meId: bigint, grade: string | null | undefined): boolean {
  if (sub.currentApproverId === null) return isApproverGrade(grade) && grade === sub.currentLevel;
  const slot = chain.find((c) => c.level === sub.currentLevel);
  if (!slot) return sub.currentApproverId === meId;
  return slot.approverId === meId && grade === sub.currentLevel;
}

export const approvalsRoutes = Router();
approvalsRoutes.get('/corrections', ...correctionList(true));

const SUB_INCLUDE = {
  file: { select: { id: true, fileName: true, fileSize: true } },
  user: { select: { id: true, email: true, displayName: true, title: true, grade: true, approverTlId: true, approverCmId: true, approverPmId: true, approverSrId: true,
    // أسماء المعتمدين المسندين — بتتعرض في الجدول تحت "دورك/منتظر" (مين المفروض يعتمد المستوى ده)
    approverTl: { select: { email: true, displayName: true, title: true } }, approverCm: { select: { email: true, displayName: true, title: true } }, approverPm: { select: { email: true, displayName: true, title: true } }, approverSr: { select: { email: true, displayName: true, title: true } },
    // المشاريع المحمّلة على الحساب بمعتمديها الخاصين — لكشف مربوط بمشروع، السلسلة بتاخد المعتمد من هنا بدل الأعمدة فوق
    userProjects: { select: {
      projectId: true, approverTlId: true, approverCmId: true, approverPmId: true, approverSrId: true,
      approverTl: { select: { email: true, displayName: true, title: true } }, approverCm: { select: { email: true, displayName: true, title: true } }, approverPm: { select: { email: true, displayName: true, title: true } }, approverSr: { select: { email: true, displayName: true, title: true } },
    } } } },
  reviews: { orderBy: { createdAt: 'asc' as const }, include: { byUser: { select: { email: true, displayName: true, title: true } } } },
  rowRejections: { orderBy: { createdAt: 'asc' as const }, include: { byUser: { select: { email: true, displayName: true, title: true } } } },
  rowEdits: { orderBy: { createdAt: 'asc' as const }, include: { byUser: { select: { email: true, displayName: true, title: true } } } },
  comments: { orderBy: { createdAt: 'asc' as const }, include: { user: { select: { id: true, email: true, displayName: true, title: true } } } },
  // النسخ القديمة اللي اتبدّلت بإعادة إرسال — الواجهة بتعرض كل واحدة سطر باهت مشطوب "تم إرسال rev NN"
  revisions: { orderBy: { revision: 'asc' as const }, select: { revision: true, submittedAt: true, replacedAt: true, gsheetRow: true, gdriveFileId: true, file: { select: { id: true, fileName: true, fileSize: true } } } },
} as const;

// إيموجيهات الريأكشن المسموحة — قائمة مغلقة، السيرفر بيرفض أي حاجة غيرها
const REACTION_EMOJIS = ['👍', '❤️', '🔥', '👏', '⚠️', '😂'] as const;

function shape(s: Record<string, unknown> & { weekStart: Date; weekEnd: Date; createdAt: Date; submittedAt?: Date }) {
  return {
    ...s,
    weekStart: s.weekStart.toISOString().slice(0, 10),
    weekEnd: s.weekEnd.toISOString().slice(0, 10),
    createdAt: s.createdAt.toISOString(),
    submittedAt: (s.submittedAt ?? s.createdAt).toISOString(),
  };
}

// أسماء المستويات (بالترتيب) — للأعمدة في الجدول
approvalsRoutes.get(
  '/levels',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ success: true, data: await getApprovalLevels() });
  }),
);

// إحصاءات سريعة لشريط أعلى تاب الاعتمادات — أرقام بس (بدون تفاصيل) عشان تفضل خفيفة.
// مسجّل قبل أي مسار '/:id' عشان "stats" ما تتفسّرش كـ id.
approvalsRoutes.get(
  '/stats',
  asyncHandler(async (req: Request, res: Response) => {
    const myId = req.user!.id;
    // "النهارده" بتوقيت القاهرة — السيرفر على Railway شغال UTC فمنتصف الليل المحلي بتاعه متأخر 3 ساعات
    const now = new Date();
    const cairoNow = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
    const cairoMidnight = new Date(cairoNow); cairoMidnight.setHours(0, 0, 0, 0);
    const dayStart = new Date(now.getTime() - (cairoNow.getTime() - cairoMidnight.getTime()));
    const [pending, myTurn, approvedToday, returnedToday, staleOver24h] = await Promise.all([
      prisma.submission.count({ where: { reviewState: 'IN_REVIEW', queueHiddenAt: null } }),
      prisma.submission.count({ where: { reviewState: 'IN_REVIEW', queueHiddenAt: null, currentApproverId: myId } }),
      prisma.submissionReview.findMany({ where: { decision: { in: ['APPROVED', 'APPROVED_NOTES'] }, createdAt: { gte: dayStart } }, select: { submissionId: true }, distinct: ['submissionId'] }).then((r) => r.length),
      prisma.submissionReview.findMany({ where: { decision: 'REJECTED', createdAt: { gte: dayStart } }, select: { submissionId: true }, distinct: ['submissionId'] }).then((r) => r.length),
      prisma.submission.count({ where: { reviewState: 'IN_REVIEW', queueHiddenAt: null, updatedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
    ]);
    res.json({ success: true, data: { pending, myTurn, approvedToday, returnedToday, staleOver24h } });
  }),
);

// قائمة الكشوف اللي في المراجعة — الجدول: كل كشف مع مستواه الحالي وقراراته
// النطاق: المعتمد بيشوف كشوف المهندسين المسندين له بس (الأدمن بيشوف الكل)
// canAct = الكشف مسند لهذا المعتمد دلوقتي (أو أدمن)
approvalsRoutes.get(
  '/queue',
  asyncHandler(async (req: Request, res: Response) => {
    const myId = req.user!.id;
    const me = await prisma.user.findUnique({ where: { id: myId }, select: { grade: true } });
    const myLevel = me?.grade ?? null;
    const isApprover = isApproverGrade(myLevel);
    const isAdmin = req.user!.role === 'ADMIN';
    // بنعرض كل اللي في المراجعة + اللي اتبعت/اترفض خلال آخر 7 أيام بس (للسياق) — عشان الطابور مايتمليش بالتاريخ
    // (19 سبتمبر 2026) ?weeks=N من زرار "📜 عرض الأقدم" — كل ضغطة بترجّع أسبوع كمان (حد أقصى سنة)
    const weeks = Math.min(52, Math.max(1, parseInt(String(req.query.weeks ?? '1'), 10) || 1));
    const since = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000);
    const stateFilter = {
      queueHiddenAt: null,
      OR: [{ reviewState: 'IN_REVIEW' }, { reviewState: { in: ['RETURNED', 'SENT'] }, submittedAt: { gte: since } }],
    };
    // (7 سبتمبر 2026 — قرار صاحب المشروع) الطابور بيعرض **كل** الكشوف لكل من عنده الوحدة (كلهم مديرين):
    // الرؤية للجميع، والاعتماد (canAct/decide) محصور على المعتمد المسند بس.
    // (8 سبتمبر 2026 — تعديل بقرار صاحب المشروع) مشاهد: حساب عنده الوحدة بس مش أدمن ولا درجته معتمِدة.
    // بيشوف **الجدول كله** بكل معلوماته وملاحظاته زي أي حد (الرؤية للجميع)، لكن مفيش أي إجراء (canAct دايمًا false،
    // والسيرفر رافض decide/reject)، وفتح الملف (`/:id/file`) مقصور على كشوفه هو بس.
    const isViewer = !isAdmin && !isApprover;
    const rows = await prisma.submission.findMany({
      where: stateFilter,
      include: SUB_INCLUDE,
      // بتاريخ إرسال النسخة الحالية: الكشف اللي اتبعت تاني بيطلع فوق
      orderBy: { submittedAt: 'desc' },
      take: Math.min(200 * weeks, 2000),
    });
    const solePmId = await soleProjectManagerId();
    const solePm = solePmId ? await prisma.user.findUnique({ where: { id: solePmId }, select: { email: true, displayName: true, title: true } }) : null;
    const nameOf = (u: { email: string; displayName?: string | null; title: string | null } | null | undefined) => (u ? (u.displayName || u.title || u.email.split('@')[0]) : null);
    const projects = await listProjects();
    const projectNameOf = (id: number | null) => (id == null ? null : (projects.find((p) => p.id === id)?.name ?? 'مشروع ' + id));
    type P = { email: string; displayName?: string | null; title: string | null } | null;
    type UP = { projectId: number; approverTlId: bigint | null; approverCmId: bigint | null; approverPmId: bigint | null; approverSrId: bigint | null; approverTl: P; approverCm: P; approverPm: P; approverSr: P };
    res.json({
      success: true,
      myLevel,
      weeks,
      since: since.toISOString(),
      // مشاهد = بيشوف الكل بلا إجراء — الواجهة بتخفي التحميل وبتعرض "مشاهدة" على كشوفه هو بس (myId للمقارنة)
      viewer: isViewer,
      myId: myId.toString(),
      // المستويات المعتمِدة بالترتيب (أعمدة الجدول) — السينيور أولها (خطوة اختيارية لكشوف الجونيور)
      activeLevels: [...CHAIN_LEVELS],
      data: rows.map((r) => {
        const u = r.user as unknown as { id: bigint; grade: string; approverTlId: bigint | null; approverCmId: bigint | null; approverPmId: bigint | null; approverSrId: bigint | null; approverTl: P; approverCm: P; approverPm: P; approverSr: P; userProjects: UP[] };
        // الكشف مربوط بمشروع، وعند صاحبه المشروع ده محمّل → السلسلة والأسماء من معتمدي المشروع بدل الأعمدة الافتراضية
        const up = r.projectId != null ? u.userProjects.find((x) => x.projectId === r.projectId) : undefined;
        const chainUser: ChainUser = up
          ? { id: u.id, grade: u.grade, approverTlId: up.approverTlId, approverCmId: up.approverCmId, approverPmId: up.approverPmId, approverSrId: up.approverSrId }
          : { id: u.id, grade: u.grade, approverTlId: u.approverTlId, approverCmId: u.approverCmId, approverPmId: u.approverPmId, approverSrId: u.approverSrId };
        const namesSrc = up ?? u;
        // مشروع بدون اعتماد → سلسلة فاضية (نفس resolveChainForUser) — كشف قديم IN_REVIEW عليه بيبان معلّق والأدمن يحرّكه للشيت
        const noApproval = r.projectId != null && !!projects.find((p) => p.id === r.projectId)?.noApproval;
        const chain = noApproval ? [] : buildChain(chainUser, solePmId);
        const inChain = chain.some((c) => c.level === r.currentLevel);
        const canAct = myLevel !== 'viewer' && r.reviewState === 'IN_REVIEW'
          && (isAdmin || isMyTurn(r, chain, myId, myLevel));
        return {
          ...shape(r as never),
          projectName: projectNameOf(r.projectId as number | null),
          // سلسلة الكشف ده تحديدًا (مستويات صاحبه) — الواجهة بتستخدمها للأعمدة الفاضية والمتخطاة
          chain: chain.map((c) => c.level),
          // مين المسند لكل مستوى في سلسلة الكشف ده (بالاسم) — الواجهة بتعرضه تحت حالة المستوى
          approverNames: Object.fromEntries(chain.map((c) => {
            const who = c.level === SENIOR_LEVEL ? namesSrc.approverSr : c.level === 'team leader' ? namesSrc.approverTl : c.level === 'construction manager' ? namesSrc.approverCm : (namesSrc.approverPm ?? solePm);
            return [c.level, nameOf(who)];
          })),
          // آخر مستوى في سلسلته → رسالة "بعد اعتمادك الكشف هيتبعت للتوقيع"
          isLast: r.reviewState === 'IN_REVIEW' && inChain && chain[chain.length - 1]?.level === r.currentLevel,
          // الكشف واقف عند مستوى مش في سلسلة صاحبه (درجته أو إسناده اتغيّر) → الأدمن بس اللي يحرّكه
          isStuck: r.reviewState === 'IN_REVIEW' && !inChain,
          // دور المعتمد ده دلوقتي: الكشف مسند له، أو كشف قديم واقف عند مستوى درجته
          // درجة 'viewer' ممنوعة من أي إجراء دايمًا (myLevel !== 'viewer') حتى لو كان مسند فعليًا بالغلط
          canAct,
          canClassify: myLevel !== 'viewer' && (isAdmin || chain.some((c) => c.approverId === myId)),
          // تعديل سطر: لمدير المشروع بس، وقت دوره، وكشوف العمالة بس (المعدات مالهاش تخطيط أعمدة العدد/السعر ده)
          canEdit: canAct && (isAdmin || myLevel === 'project manager') && r.kind !== 'equipment',
        };
      }),
    });
  }),
);

// ملف الكشف للمراجعة/التحميل من تاب الاعتمادات — لأي حساب عنده وحدة approvals (المعتمدين مش أصحاب الملف ولا أدمن،
// فمسار /submissions/:id/file بيرفضهم: محمي بوحدة submissions وبشرط صاحب الملف/أدمن)
// (7 سبتمبر 2026 — قرار صاحب المشروع) الملف متاح لأي حساب عنده وحدة الاعتمادات (كلهم مديرين — الرؤية للجميع
// زي الطابور)، والاعتماد نفسه هو المحصور على المعتمد المسند. الوحدة بتتمنح من الأدمن فقط (requireModule).
approvalsRoutes.get(
  '/:id/file',
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const sub = await prisma.submission.findUnique({ where: { id: BigInt(req.params.id) }, include: { file: true, rowRejections: true } });
    if (!sub) throw AppError.notFound('الكشف غير موجود');
    // (8 سبتمبر 2026) المشاهد الضمني (مش أدمن ولا درجته معتمِدة) بيفتح كشوفه هو بس.
    // (12 سبتمبر 2026) درجة 'viewer' الصريحة استثناء: بتفتح أي كشف — الرؤية الكاملة هي بيت القصيد من الدرجة دي.
    if (req.user!.role !== 'ADMIN') {
      const me = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { grade: true } });
      const isApprover = isApproverGrade(me?.grade);
      const isExplicitViewer = me?.grade === 'viewer';
      if (!isApprover && !isExplicitViewer && sub.userId !== req.user!.id) throw AppError.notFound('الكشف غير موجود');
    }
    // بعد اكتمال السلسلة (SENT) المعاينة/التحميل بيرجّعوا النسخة **الموقّعة** — نفس اللي وصلت جوجل شيت.
    // أثناء المراجعة بيرجّع الأصل زي ما بعته المهندس + السطور المشطوبة (عشان المعتمد اللي بعده يشوفها).
    // (8 سبتمبر 2026) أثناء المراجعة كمان: توقيعات اللي اعتمدوا لحد دلوقتي بتنزل على الكشف + "معتمد بواسطة" تحت عنوان البلوك —
    // فالمعتمد اللي بعده يشوف مين اعتمد قبله. بعد SENT نفس الشيء (كل التوقيعات). السطور المشطوبة بالأحمر في الحالتين.
    // (أكتوبر 2026) ?rev=N = نسخة قديمة اتبدّلت بإعادة إرسال (السطر الباهت في الطابور) — ملفها هي بشطبها وتوقيعاتها
    let file = sub.file;
    let revision: number | undefined;
    if (req.query.rev !== undefined && Number(req.query.rev) !== sub.revision) {
      revision = Number(req.query.rev);
      if (!Number.isInteger(revision) || revision < 0) throw AppError.validation('رقم النسخة غير صحيح');
      const old = await prisma.submissionRevision.findUnique({ where: { submissionId_revision: { submissionId: sub.id, revision } }, include: { file: true } });
      if (!old?.file) throw AppError.notFound('ملف النسخة دي مش محفوظ');
      file = old.file;
    }
    const buffer: Buffer | null = await signedFileBuffer(sub.id, 'strike', revision);
    if (!buffer) throw AppError.notFound('ملف الكشف لم يعد موجودًا على السيرفر');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.send(buffer);
  }),
);

// الأدمن يخفي صف من طابور الاعتمادات (تنظيف العرض فقط): الكشف وسجل المراجعات و"تسليماتي" وجوجل شيت ما بيتأثروش.
// مسموح بس للكشوف اللي خلصت (SENT) أو رجعت للمهندس (RETURNED) — اللي لسه في المراجعة لازم يفضل ظاهر عشان المعتمد يشوفه
approvalsRoutes.post(
  '/:id/hide',
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    if (req.user!.role !== 'ADMIN') throw AppError.forbidden('الإخفاء للأدمن فقط');
    const id = BigInt(req.params.id);
    const sub = await prisma.submission.findUnique({ where: { id }, select: { reviewState: true, queueHiddenAt: true } });
    if (!sub) throw AppError.notFound('الكشف غير موجود');
    if (sub.reviewState === 'IN_REVIEW') throw AppError.validation('الكشف لسه في المراجعة — ما ينفعش يتخفي قبل ما السلسلة تخلص أو يترفض');
    if (!sub.queueHiddenAt) await prisma.submission.update({ where: { id }, data: { queueHiddenAt: new Date() } });
    res.json({ success: true });
  }),
);

// ── شطب سطر (رفض جزئي): من أي مستوى دوره على الكشف، بسبب إلزامي، بلا إلغاء ──
// لو كل سطور البيانات في الملف اتشطبت → رفض كامل تلقائي (يرجع للمهندس). غير كده الكشف يكمّل السلسلة بدون السطر.
approvalsRoutes.post(
  '/:id/rows/reject',
  requireWindow('approve'),
  validate({ params: idParamSchema, body: z.object({
    sheetIndex: z.coerce.number().int().min(0).max(200),
    row: z.coerce.number().int().min(1).max(100),
    label: z.string().trim().min(1).max(190),
    note: z.string().trim().min(1, 'اكتب سبب الشطب').max(500),
    disposition: z.enum(['CORRECTION', 'FINAL']),
  }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = BigInt(req.params.id);
    const { sheetIndex, row, label, note, disposition } = req.body as { sheetIndex: number; row: number; label: string; note: string; disposition: string };
    const sub = await prisma.submission.findUnique({ where: { id }, include: { file: true, rowRejections: true } });
    if (!sub) throw AppError.notFound('الكشف غير موجود');
    if (sub.reviewState !== 'IN_REVIEW') throw AppError.validation('الكشف مش في مرحلة مراجعة');
    const me = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { grade: true } });
    // درجة 'viewer' ممنوعة من أي إجراء اعتماد/رفض — قبل أي فحص تاني، حتى لو كان مسند أو مستوى قديم
    if (me?.grade === 'viewer') throw AppError.forbidden('حساب مشاهد — مالوش صلاحية اعتماد أو رفض');
    const isAdmin = req.user!.role === 'ADMIN';
    if (!isAdmin && !isMyTurn(sub, await resolveChainForUser(sub.userId, sub.projectId), req.user!.id, me?.grade)) throw AppError.forbidden('مش دورك في الاعتماد على الكشف ده دلوقتي');
    if (sub.rowRejections.some((r) => r.revision === sub.revision && r.sheetIndex === sheetIndex && r.row === row)) throw AppError.validation('السطر ده مشطوب بالفعل');
    const level = isAdmin && !sub.currentLevel ? 'admin' : (sub.currentLevel ?? 'admin');
    const original = await storage.read(sub.file.filePath).catch(() => null);
    if (!original) throw AppError.notFound('ملف المصدر غير موجود');
    const wb = await workbook(original);
    const ws = wb.worksheets[sheetIndex];
    if (!ws || !dataRowsOf(ws, sub.kind === 'equipment' ? 'equipment' : 'labor').includes(row)) throw AppError.validation('الصف ليس يوم بيانات في الكشف');
    const total = (await countDataRows(original, sub.kind === 'equipment' ? 'equipment' : 'labor'))!;
    const result = await prisma.$transaction(async (tx) => {
      await lockSubmission(tx, id);
      const current = await tx.submission.findUnique({ where: { id } });
      if (!current || current.revision !== sub.revision || current.reviewState !== 'IN_REVIEW' || current.currentLevel !== sub.currentLevel || current.currentApproverId !== sub.currentApproverId) throw AppError.conflict('حالة الكشف اتغيّرت — حدّث القائمة');
      if (disposition === 'FINAL' && await tx.correctionLink.count({ where: { replacementId: id, revision: sub.revision, sheetIndex, row, activeTaskId: { not: null } } })) throw AppError.validation('اليوم يعالج طلب تصحيح قائم — استخدم مطلوب تصحيح للإبقاء على المتابعة');
      const rejection = await tx.submissionRowRejection.create({ data: { submissionId: id, revision: sub.revision, sheetIndex, row, label, note, disposition, classifiedById: req.user!.id, classifiedAt: new Date(), classificationNote: note, level, byUserId: req.user!.id } });
      await tx.submission.update({ where: { id }, data: { updatedAt: new Date() } });
      if (disposition === 'CORRECTION') await classified(tx, current, req.user!.id, sheetIndex, row, note);
      // FINAL is audited too, without creating a correction obligation.
      await tx.submissionComment.create({ data: { submissionId: id, userId: req.user!.id, kind: 'comment', body: `تصنيف شطب ${sheetIndex}:${row} — ${disposition}: ${note}`.slice(0, 500) } });
      const struck = await tx.submissionRowRejection.count({ where: { submissionId: id, revision: sub.revision } });
      const fullyRejected = total > 0 && struck >= total;
      if (fullyRejected) {
        await tx.submissionReview.create({ data: { submissionId: id, level: sub.currentLevel ?? '', decision: 'REJECTED', note: 'كل سطور الكشف اتشطبت — آخر سبب: ' + note, revision: sub.revision, byUserId: req.user!.id } });
        await tx.submission.update({ where: { id }, data: { reviewState: 'RETURNED', currentLevel: null, currentApproverId: null } });
        // If every row is FINAL, keep its financial rejection but create no correction task.
        if (await tx.submissionRowRejection.count({ where: { submissionId: id, revision: sub.revision, disposition: { not: 'FINAL' } } })) await returned(tx, current, req.user!.id, note);
      }
      return { rejection, struck, fullyRejected };
    });
    const { rejection, struck, fullyRejected } = result;
    res.status(201).json({ success: true, data: { ...rejection, id: rejection.id.toString(), submissionId: rejection.submissionId.toString(), byUserId: rejection.byUserId?.toString() ?? null }, fullyRejected, struck, total });
  }),
);

// Legacy rows remain unclassified until an assigned approver explicitly chooses.
approvalsRoutes.post('/:id/rows/classify', requireWindow('approve'), validate({ params: idParamSchema, body: z.object({
  revision: z.number().int().min(0), sheetIndex: z.number().int().min(0), row: z.number().int().min(1),
  disposition: z.enum(['CORRECTION', 'FINAL']), note: z.string().trim().min(1).max(500),
}) }), asyncHandler(async (req, res) => {
  const id = BigInt(req.params.id);
  const sub = await prisma.submission.findUnique({ where: { id } });
  if (!sub) throw AppError.notFound('الكشف غير موجود');
  const me = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { grade: true } });
  const chain = await resolveChainForUser(sub.userId, sub.projectId);
  if (me?.grade === 'viewer' || (req.user!.role !== 'ADMIN' && !chain.some((c) => c.approverId === req.user!.id))) throw AppError.forbidden();
  if (req.body.revision !== sub.revision) throw AppError.conflict('لا يمكن تغيير تصنيف نسخة قديمة بعد إعادة إرسالها');
  await prisma.$transaction(async (tx) => {
    await lockSubmission(tx, id);
    const fresh = await tx.submission.findUnique({ where: { id } });
    if (!fresh || fresh.revision !== req.body.revision) throw AppError.conflict('اتغيّرت نسخة الكشف');
    const changed = await tx.submissionRowRejection.updateMany({ where: { submissionId: id, revision: req.body.revision, sheetIndex: req.body.sheetIndex, row: req.body.row, disposition: null }, data: { disposition: req.body.disposition, classifiedById: req.user!.id, classifiedAt: new Date(), classificationNote: req.body.note } });
    if (!changed.count) throw AppError.conflict('السطر غير موجود أو تم تصنيفه — إعادة فتح تصنيف نهائي خارج المرحلة الأولى');
    const strike = await tx.submissionRowRejection.findUniqueOrThrow({ where: { submissionId_revision_sheetIndex_row: { submissionId: id, revision: req.body.revision, sheetIndex: req.body.sheetIndex, row: req.body.row } } });
    if (req.body.disposition === 'CORRECTION') await classified(tx, sub, req.user!.id, strike.sheetIndex, strike.row, strike.note, true);
    await tx.submissionComment.create({ data: { submissionId: id, userId: req.user!.id, kind: 'comment', body: `تصنيف شطب قديم ${strike.sheetIndex}:${strike.row} — ${req.body.disposition}: ${req.body.note}`.slice(0, 500) } });
  });
  res.json({ success: true });
}));

function round2(n: number): number { return Math.round(n * 100) / 100; }

// ── تعديل سطر: لمدير المشروع بس، بدل شطبه — العدد/السعر/البيان/الخصم على، بسبب إلزامي ──
// الكشف يكمّل السلسلة عادي (مفيش رجوع للمهندس). كشوف العمالة بس (المعدات مالهاش نفس التخطيط).
approvalsRoutes.post(
  '/:id/rows/edit',
  requireWindow('approve'),
  validate({ params: idParamSchema, body: z.object({
    sheetIndex: z.coerce.number().int().min(0).max(200),
    row: z.coerce.number().int().min(8).max(14),
    label: z.string().trim().min(1).max(190),
    note: z.string().trim().min(1, 'اكتب سبب التعديل').max(500),
    qty: z.coerce.number().positive().max(100000).optional(),
    price: z.coerce.number().min(0).max(10000000).optional(),
    notes: z.string().trim().max(1000).optional(),
    deduct: z.string().trim().max(1000).optional(),
  }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = BigInt(req.params.id);
    const { sheetIndex, row, label, note, qty, price, notes, deduct } = req.body as {
      sheetIndex: number; row: number; label: string; note: string;
      qty?: number; price?: number; notes?: string; deduct?: string;
    };
    if (qty === undefined && price === undefined && notes === undefined && deduct === undefined) {
      throw AppError.validation('مفيش تعديل');
    }
    const sub = await prisma.submission.findUnique({ where: { id }, include: { file: true, rowRejections: true, rowEdits: true } });
    if (!sub) throw AppError.notFound('الكشف غير موجود');
    if (sub.reviewState !== 'IN_REVIEW') throw AppError.validation('الكشف مش في مرحلة مراجعة');
    if (sub.kind !== 'labor') throw AppError.validation('تعديل السطور متاح لكشوف العمالة بس');
    const me = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { grade: true } });
    // (17 سبتمبر 2026 — قرار صاحب المشروع) مدير النظام (أدمن) بيعدّل أي كشف في المراجعة من غير شرط الدرجة أو الدور؛
    // غيره: مدير المشروع بس، ووقت دوره على الكشف
    const isAdmin = req.user!.role === 'ADMIN';
    if (!isAdmin) {
      if (me?.grade !== 'project manager') throw AppError.forbidden('تعديل السطور لمدير المشروع أو مدير النظام بس');
      if (!isMyTurn(sub, await resolveChainForUser(sub.userId, sub.projectId), req.user!.id, me.grade)) throw AppError.forbidden('مش دورك في الاعتماد على الكشف ده دلوقتي');
    }
    if (sub.rowRejections.some((r) => r.revision === sub.revision && r.sheetIndex === sheetIndex && r.row === row)) throw AppError.validation('السطر ده مشطوب');

    const original = await storage.read(sub.file.filePath).catch(() => null);
    if (!original) throw AppError.validation('ملف الكشف الأصلي مش موجود على السيرفر');
    let wb: ExcelJS.Workbook;
    try {
      wb = new ExcelJS.Workbook();
      await validateWorkbook(original);
      await wb.xlsx.load(original as unknown as ArrayBuffer);
    } catch {
      throw AppError.validation('تعذّرت قراءة ملف الكشف');
    }
    const ws = wb.worksheets[sheetIndex];
    if (!ws) throw AppError.validation('الورقة غير موجودة');
    const dateVal = ws.getCell(row, 13).value;
    const totalVal = ws.getCell(row, 8).value;
    if (!dateVal || totalVal == null || totalVal === '') throw AppError.validation('السطر ده مفيهوش بيانات');
    const orig = readLaborRow(ws, row);
    if (orig.multi && (qty !== undefined || price !== undefined)) {
      throw AppError.validation('السطر فيه أكتر من سجل في نفس اليوم — تقدر تعدّل البيان أو الخصم بس، أو تشطبه');
    }

    const existing = sub.rowEdits.find((e) => e.revision === sub.revision && e.sheetIndex === sheetIndex && e.row === row);
    const qtyTo = qty !== undefined ? String(qty) : (existing?.qtyTo ?? null);
    const qtyFrom = qty !== undefined ? (existing?.qtyFrom ?? (orig.qty != null ? String(orig.qty) : null)) : (existing?.qtyFrom ?? null);
    const priceTo = price !== undefined ? String(price) : (existing?.priceTo ?? null);
    const priceFrom = price !== undefined ? (existing?.priceFrom ?? (orig.price != null ? String(orig.price) : null)) : (existing?.priceFrom ?? null);
    const notesTo = notes !== undefined ? notes : (existing?.notesTo ?? null);
    const notesFrom = notes !== undefined ? (existing?.notesFrom ?? orig.notes) : (existing?.notesFrom ?? null);
    const deductTo = deduct !== undefined ? deduct : (existing?.deductTo ?? null);
    const deductFrom = deduct !== undefined ? (existing?.deductFrom ?? orig.deduct) : (existing?.deductFrom ?? null);
    let totalTo: string | null = existing?.totalTo ?? null;
    let totalFrom: string | null = existing?.totalFrom ?? null;
    if (qtyTo != null || priceTo != null) {
      const finalQty = qtyTo != null ? Number(qtyTo) : (orig.qty ?? 0);
      const finalPrice = priceTo != null ? Number(priceTo) : (orig.price ?? 0);
      totalTo = String(round2(finalQty * finalPrice));
      totalFrom = existing?.totalFrom ?? String(orig.total);
    }

    const data = {
      label, level: isAdmin ? 'admin' : 'project manager', note, byUserId: req.user!.id,
      qtyFrom, qtyTo, priceFrom, priceTo, notesFrom, notesTo, deductFrom, deductTo, totalFrom, totalTo,
    };
    const edit = await prisma.$transaction(async (tx) => {
      await lockSubmission(tx, id);
      const current = await tx.submission.findUnique({ where: { id } });
      if (!current || current.revision !== sub.revision || current.reviewState !== 'IN_REVIEW' || current.currentLevel !== sub.currentLevel || current.currentApproverId !== sub.currentApproverId || current.updatedAt.getTime() !== sub.updatedAt.getTime()) throw AppError.conflict('حالة الكشف اتغيّرت — حدّث المعاينة');
      if (await tx.submissionRowRejection.count({ where: { submissionId: id, revision: sub.revision, sheetIndex, row } })) throw AppError.conflict('السطر اتشطب أثناء التعديل');
      await tx.submission.update({ where: { id }, data: { updatedAt: new Date() } });
    return tx.submissionRowEdit.upsert({
      where: { submissionId_revision_sheetIndex_row: { submissionId: id, revision: sub.revision, sheetIndex, row } },
      create: { submissionId: id, revision: sub.revision, sheetIndex, row, ...data },
      update: data,
    });
    });
    res.status(201).json({ success: true, data: { ...edit, id: edit.id.toString(), submissionId: edit.submissionId.toString(), byUserId: edit.byUserId?.toString() ?? null } });
  }),
);

// قرار اعتماد: معتمد بدون ملاحظات / معتمد بملاحظات / مرفوض بملاحظات
approvalsRoutes.post(
  '/:id/decide',
  requireWindow('approve'),
  validate({ params: idParamSchema, body: z.object({ decision: z.enum(['APPROVED', 'APPROVED_NOTES', 'REJECTED']), note: z.string().trim().max(500).optional().default('') }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = BigInt(req.params.id);
    const decision = req.body.decision as 'APPROVED' | 'APPROVED_NOTES' | 'REJECTED';
    const note = (req.body.note as string) || '';
    if (decision !== 'APPROVED' && !note.trim()) throw AppError.validation('لازم تكتب ملاحظة مع الاعتماد بملاحظات أو الرفض');

    const sub = await prisma.submission.findUnique({ where: { id } });
    if (!sub) throw AppError.notFound('الكشف غير موجود');
    if (sub.reviewState !== 'IN_REVIEW') throw AppError.validation('الكشف مش في مرحلة مراجعة');

    // صلاحية: الكشف لازم يكون مسند للمعتمد ده (الأدمن بيقدر يعتمد أي مستوى)
    const me = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { grade: true } });
    // درجة 'viewer' ممنوعة من أي إجراء اعتماد/رفض — قبل أي فحص تاني، حتى لو كان مسند أو مستوى قديم
    if (me?.grade === 'viewer') throw AppError.forbidden('حساب مشاهد — مالوش صلاحية اعتماد أو رفض');
    const isAdmin = req.user!.role === 'ADMIN';
    const chain = await resolveChainForUser(sub.userId, sub.projectId);
    if (!isAdmin && !isMyTurn(sub, chain, req.user!.id, me?.grade)) {
      throw AppError.forbidden('مش دورك في الاعتماد على الكشف ده دلوقتي');
    }

    // نحدد نتيجة القرار الأول (قبل ما نسجّل أي حاجة) — عشان الكشف الواقف عند مستوى اتشال من سلسلته ما يتبعتش قبل أوانه
    let step = nextLevel(chain, sub.currentLevel);
    if (decision !== 'REJECTED' && step.kind === 'stuck') {
      if (!isAdmin) {
        throw AppError.validation('المستوى الحالي للكشف مش موجود في سلسلة اعتماد صاحبه (درجته أو المعتمدين المسندين له اتغيّروا) — الأدمن هو اللي يقدر يحرّكه');
      }
      // الأدمن بيفكّه: يكمّل من أول مستوى في السلسلة الحالية، ولو السلسلة فاضية خالص → خلصت
      step = chain[0] ? { kind: 'next', ...chain[0] } : { kind: 'done' };
    }

    const stateData = decision === 'REJECTED'
      ? { reviewState: 'RETURNED', currentLevel: null, currentApproverId: null }
      : step.kind === 'next'
        // معتمد (بملاحظات أو بدون) → المستوى اللي بعده والشخص المسند له
        ? { currentLevel: step.level, currentApproverId: step.approverId }
        // السلسلة خلصت → يتبعت لجوجل
        : { reviewState: 'SENT', currentLevel: null, currentApproverId: null };

    const accounting = decision !== 'REJECTED' && step.kind === 'done' ? await prepareApprovalAccounting(id) : null;
    if (decision !== 'REJECTED' && step.kind === 'done' && sub.kind === 'labor' && !accounting && await prisma.correctionLink.count({ where: { replacementId: id, revision: sub.revision, activeTaskId: { not: null } } })) throw AppError.notFound('ملف التصحيح غير موجود أو غير قابل للحساب — لا يمكن إغلاق الطلب');
    const fresh = await prisma.$transaction(async (tx) => {
      await lockSubmission(tx, id);
      // compare-and-set على حالة المستوى يمنع قرارين متزامنين من إنشاء مراجعتين أو تخطي مستوى.
      const advanced = await tx.submission.updateMany({
        where: {
          id,
          reviewState: 'IN_REVIEW',
          revision: sub.revision,
          updatedAt: sub.updatedAt,
          currentLevel: sub.currentLevel,
          currentApproverId: sub.currentApproverId,
        },
        data: { ...stateData, ...(accounting ? { approvedTotal: accounting.total } : {}) },
      });
      if (advanced.count === 0) throw AppError.conflict('حالة الكشف اتغيّرت أو اتاخد قرار فيه بالفعل');

      await tx.submissionReview.create({
        data: { submissionId: id, level: sub.currentLevel ?? '', decision, note: note.trim() || null, revision: sub.revision, byUserId: req.user!.id },
      });
      if (accounting) {
        await tx.submissionLaborDays.deleteMany({ where: { submissionId: id } });
        if (accounting.days.length) await tx.submissionLaborDays.createMany({ data: accounting.days.map((d) => ({ ...d, submissionId: id })) });
      }
      if (decision === 'REJECTED') await returned(tx, sub, req.user!.id, note);
      else if (step.kind === 'done') await completed(tx, sub, req.user!.id);
      return tx.submission.findUnique({ where: { id }, include: SUB_INCLUDE });
    });
    if (decision !== 'REJECTED' && step.kind === 'done') void pushSubmissionToSheet(id).catch(() => console.error('[approval] Google sync failed; approval remains recorded')); // ☁️ مرة واحدة بعد نجاح الانتقال
    res.json({ success: true, data: shape(fresh as never) });
  }),
);

function shapeComments(list: Array<{ id: bigint; submissionId: bigint; userId: bigint; kind: string; body: string; createdAt: Date; user: { id: bigint; email: string; displayName: string | null; title: string | null } }>) {
  return list.map((c) => ({
    id: c.id.toString(),
    submissionId: c.submissionId.toString(),
    userId: c.userId.toString(),
    kind: c.kind,
    body: c.body,
    createdAt: c.createdAt.toISOString(),
    user: { id: c.user.id.toString(), email: c.user.email, displayName: c.user.displayName, title: c.user.title },
  }));
}

async function freshComments(submissionId: bigint) {
  const rows = await prisma.submissionComment.findMany({
    where: { submissionId },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { id: true, email: true, displayName: true, title: true } } },
  });
  return shapeComments(rows);
}

// ريأكشن على كشف — تبديل: لو المستخدم حاط نفس الإيموجي قبل كده بيتشال، غير كده بيتضاف.
// متاح لأي حساب عنده وحدة approvals (بما فيهم المشاهد — الرؤية والتفاعل للجميع)
approvalsRoutes.post(
  '/:id/react',
  validate({ params: idParamSchema, body: z.object({ emoji: z.enum(REACTION_EMOJIS) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = BigInt(req.params.id);
    const { emoji } = req.body as { emoji: typeof REACTION_EMOJIS[number] };
    const sub = await prisma.submission.findUnique({ where: { id }, select: { id: true } });
    if (!sub) throw AppError.notFound('الكشف غير موجود');
    const existing = await prisma.submissionComment.findFirst({ where: { submissionId: id, userId: req.user!.id, kind: 'reaction', body: emoji } });
    if (existing) {
      await prisma.submissionComment.delete({ where: { id: existing.id } });
    } else {
      await prisma.submissionComment.create({ data: { submissionId: id, userId: req.user!.id, kind: 'reaction', body: emoji } });
    }
    res.json({ success: true, data: await freshComments(id) });
  }),
);

// كومنت نصي على كشف
approvalsRoutes.post(
  '/:id/comments',
  validate({ params: idParamSchema, body: z.object({ body: z.string().trim().min(1, 'اكتب تعليق').max(500) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = BigInt(req.params.id);
    const sub = await prisma.submission.findUnique({ where: { id }, select: { id: true } });
    if (!sub) throw AppError.notFound('الكشف غير موجود');
    await prisma.submissionComment.create({ data: { submissionId: id, userId: req.user!.id, kind: 'comment', body: (req.body as { body: string }).body } });
    res.status(201).json({ success: true, data: await freshComments(id) });
  }),
);

// حذف كومنت — صاحبه أو الأدمن بس
approvalsRoutes.delete(
  '/:id/comments/:commentId',
  validate({ params: idParamSchema.extend({ commentId: z.coerce.bigint() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = BigInt(req.params.id);
    const commentId = BigInt(req.params.commentId);
    const comment = await prisma.submissionComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.submissionId !== id) throw AppError.notFound('التعليق غير موجود');
    const isAdmin = req.user!.role === 'ADMIN';
    if (!isAdmin && comment.userId !== req.user!.id) throw AppError.forbidden('تقدر تمسح تعليقاتك إنت بس');
    await prisma.submissionComment.delete({ where: { id: commentId } });
    res.json({ success: true, data: await freshComments(id) });
  }),
);
