import { Router, Request, Response } from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middlewares/validate';
import { requireWindow } from '../middlewares/windowGuard';
import { idParamSchema } from '../utils/crudFactory';
import { getApprovalLevels, APPROVING_GRADES, buildChain, nextLevel, resolveChainForUser, soleProjectManagerId, pushSubmissionToSheet, signedFileBuffer, ChainUser } from '../services/approvalChain';
import { countDataRows, readLaborRow } from '../services/rowReject';
import { storage } from '../services/storage';
import { listProjects } from '../services/placeSite';

// ═══════════ اعتمادات المديرين — تبويب المراجعة والاعتماد ═══════════
// (authenticate + requireModule('approvals') مطبّقين في routes/index.ts)

export const approvalsRoutes = Router();

const SUB_INCLUDE = {
  file: { select: { id: true, fileName: true, fileSize: true } },
  user: { select: { id: true, email: true, displayName: true, title: true, grade: true, approverTlId: true, approverCmId: true, approverPmId: true,
    // أسماء المعتمدين المسندين — بتتعرض في الجدول تحت "دورك/منتظر" (مين المفروض يعتمد المستوى ده)
    approverTl: { select: { email: true, displayName: true, title: true } }, approverCm: { select: { email: true, displayName: true, title: true } }, approverPm: { select: { email: true, displayName: true, title: true } },
    // المشاريع المحمّلة على الحساب بمعتمديها الخاصين — لكشف مربوط بمشروع، السلسلة بتاخد المعتمد من هنا بدل الأعمدة فوق
    userProjects: { select: {
      projectId: true, approverTlId: true, approverCmId: true, approverPmId: true,
      approverTl: { select: { email: true, displayName: true, title: true } }, approverCm: { select: { email: true, displayName: true, title: true } }, approverPm: { select: { email: true, displayName: true, title: true } },
    } } } },
  reviews: { orderBy: { createdAt: 'asc' as const }, include: { byUser: { select: { email: true, displayName: true, title: true } } } },
  rowRejections: { orderBy: { createdAt: 'asc' as const }, include: { byUser: { select: { email: true, displayName: true, title: true } } } },
  rowEdits: { orderBy: { createdAt: 'asc' as const }, include: { byUser: { select: { email: true, displayName: true, title: true } } } },
} as const;

function shape(s: Record<string, unknown> & { weekStart: Date; weekEnd: Date; createdAt: Date }) {
  return {
    ...s,
    weekStart: s.weekStart.toISOString().slice(0, 10),
    weekEnd: s.weekEnd.toISOString().slice(0, 10),
    createdAt: s.createdAt.toISOString(),
  };
}

// أسماء المستويات (بالترتيب) — للأعمدة في الجدول
approvalsRoutes.get(
  '/levels',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ success: true, data: await getApprovalLevels() });
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
    const isApprover = myLevel != null && (APPROVING_GRADES as readonly string[]).includes(myLevel);
    const isAdmin = req.user!.role === 'ADMIN';
    // بنعرض كل اللي في المراجعة + اللي اتبعت/اترفض خلال آخر 7 أيام بس (للسياق) — عشان الطابور مايتمليش بالتاريخ
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const stateFilter = {
      queueHiddenAt: null,
      OR: [{ reviewState: 'IN_REVIEW' }, { reviewState: { in: ['RETURNED', 'SENT'] }, createdAt: { gte: since } }],
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
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const solePmId = await soleProjectManagerId();
    const solePm = solePmId ? await prisma.user.findUnique({ where: { id: solePmId }, select: { email: true, displayName: true, title: true } }) : null;
    const nameOf = (u: { email: string; displayName?: string | null; title: string | null } | null | undefined) => (u ? (u.displayName || u.title || u.email.split('@')[0]) : null);
    const projects = await listProjects();
    const projectNameOf = (id: number | null) => (id == null ? null : (projects.find((p) => p.id === id)?.name ?? 'مشروع ' + id));
    type P = { email: string; displayName?: string | null; title: string | null } | null;
    type UP = { projectId: number; approverTlId: bigint | null; approverCmId: bigint | null; approverPmId: bigint | null; approverTl: P; approverCm: P; approverPm: P };
    res.json({
      success: true,
      myLevel,
      // مشاهد = بيشوف الكل بلا إجراء — الواجهة بتخفي التحميل وبتعرض "مشاهدة" على كشوفه هو بس (myId للمقارنة)
      viewer: isViewer,
      myId: myId.toString(),
      // المستويات المعتمِدة بالترتيب (أعمدة الجدول)
      activeLevels: [...APPROVING_GRADES],
      data: rows.map((r) => {
        const u = r.user as unknown as { id: bigint; grade: string; approverTlId: bigint | null; approverCmId: bigint | null; approverPmId: bigint | null; approverTl: P; approverCm: P; approverPm: P; userProjects: UP[] };
        // الكشف مربوط بمشروع، وعند صاحبه المشروع ده محمّل → السلسلة والأسماء من معتمدي المشروع بدل الأعمدة الافتراضية
        const up = r.projectId != null ? u.userProjects.find((x) => x.projectId === r.projectId) : undefined;
        const chainUser: ChainUser = up
          ? { id: u.id, grade: u.grade, approverTlId: up.approverTlId, approverCmId: up.approverCmId, approverPmId: up.approverPmId }
          : { id: u.id, grade: u.grade, approverTlId: u.approverTlId, approverCmId: u.approverCmId, approverPmId: u.approverPmId };
        const namesSrc = up ?? u;
        const chain = buildChain(chainUser, solePmId);
        const inChain = chain.some((c) => c.level === r.currentLevel);
        const canAct = myLevel !== 'viewer' && r.reviewState === 'IN_REVIEW'
          && (isAdmin
            || r.currentApproverId === myId
            || (r.currentApproverId === null && isApprover && r.currentLevel === myLevel));
        return {
          ...shape(r as never),
          projectName: projectNameOf(r.projectId as number | null),
          // سلسلة الكشف ده تحديدًا (مستويات صاحبه) — الواجهة بتستخدمها للأعمدة الفاضية والمتخطاة
          chain: chain.map((c) => c.level),
          // مين المسند لكل مستوى في سلسلة الكشف ده (بالاسم) — الواجهة بتعرضه تحت حالة المستوى
          approverNames: Object.fromEntries(chain.map((c) => {
            const who = c.level === 'team leader' ? namesSrc.approverTl : c.level === 'construction manager' ? namesSrc.approverCm : (namesSrc.approverPm ?? solePm);
            return [c.level, nameOf(who)];
          })),
          // آخر مستوى في سلسلته → رسالة "بعد اعتمادك الكشف هيتبعت للتوقيع"
          isLast: r.reviewState === 'IN_REVIEW' && inChain && chain[chain.length - 1]?.level === r.currentLevel,
          // الكشف واقف عند مستوى مش في سلسلة صاحبه (درجته أو إسناده اتغيّر) → الأدمن بس اللي يحرّكه
          isStuck: r.reviewState === 'IN_REVIEW' && !inChain,
          // دور المعتمد ده دلوقتي: الكشف مسند له، أو كشف قديم واقف عند مستوى درجته
          // درجة 'viewer' ممنوعة من أي إجراء دايمًا (myLevel !== 'viewer') حتى لو كان مسند فعليًا بالغلط
          canAct,
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
      const isApprover = !!me?.grade && (APPROVING_GRADES as readonly string[]).includes(me.grade);
      const isExplicitViewer = me?.grade === 'viewer';
      if (!isApprover && !isExplicitViewer && sub.userId !== req.user!.id) throw AppError.notFound('الكشف غير موجود');
    }
    // بعد اكتمال السلسلة (SENT) المعاينة/التحميل بيرجّعوا النسخة **الموقّعة** — نفس اللي وصلت جوجل شيت.
    // أثناء المراجعة بيرجّع الأصل زي ما بعته المهندس + السطور المشطوبة (عشان المعتمد اللي بعده يشوفها).
    // (8 سبتمبر 2026) أثناء المراجعة كمان: توقيعات اللي اعتمدوا لحد دلوقتي بتنزل على الكشف + "معتمد بواسطة" تحت عنوان البلوك —
    // فالمعتمد اللي بعده يشوف مين اعتمد قبله. بعد SENT نفس الشيء (كل التوقيعات). السطور المشطوبة بالأحمر في الحالتين.
    const buffer: Buffer | null = await signedFileBuffer(sub.id, 'strike');
    if (!buffer) throw AppError.notFound('ملف الكشف لم يعد موجودًا على السيرفر');
    res.setHeader('Content-Type', sub.file.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(sub.file.fileName)}`);
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
  }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = BigInt(req.params.id);
    const { sheetIndex, row, label, note } = req.body as { sheetIndex: number; row: number; label: string; note: string };
    const sub = await prisma.submission.findUnique({ where: { id }, include: { file: true, rowRejections: true } });
    if (!sub) throw AppError.notFound('الكشف غير موجود');
    if (sub.reviewState !== 'IN_REVIEW') throw AppError.validation('الكشف مش في مرحلة مراجعة');
    const me = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { grade: true } });
    // درجة 'viewer' ممنوعة من أي إجراء اعتماد/رفض — قبل أي فحص تاني، حتى لو كان مسند أو مستوى قديم
    if (me?.grade === 'viewer') throw AppError.forbidden('حساب مشاهد — مالوش صلاحية اعتماد أو رفض');
    const isAdmin = req.user!.role === 'ADMIN';
    const isApprover = !!me?.grade && (APPROVING_GRADES as readonly string[]).includes(me.grade);
    const mine = sub.currentApproverId === req.user!.id || (sub.currentApproverId === null && isApprover && me!.grade === sub.currentLevel);
    if (!isAdmin && !mine) throw AppError.forbidden('مش دورك في الاعتماد على الكشف ده دلوقتي');
    if (sub.rowRejections.some((r) => r.revision === sub.revision && r.sheetIndex === sheetIndex && r.row === row)) throw AppError.validation('السطر ده مشطوب بالفعل');
    const level = isAdmin && !sub.currentLevel ? 'admin' : (sub.currentLevel ?? 'admin');
    const rejection = await prisma.submissionRowRejection.create({
      data: { submissionId: id, revision: sub.revision, sheetIndex, row, label, note, level, byUserId: req.user!.id },
    });
    // كل السطور اتشطبت؟ → رفض كامل
    let fullyRejected = false;
    const original = await storage.read(sub.file.filePath).catch(() => null);
    const total = original ? await countDataRows(original, sub.kind === 'equipment' ? 'equipment' : 'labor') : null;
    const struck = new Set(sub.rowRejections.filter((r) => r.revision === sub.revision).map((r) => r.sheetIndex + ':' + r.row)).add(sheetIndex + ':' + row).size;
    if (total !== null && total > 0 && struck >= total) {
      fullyRejected = true;
      await prisma.submissionReview.create({
        data: { submissionId: id, level: sub.currentLevel ?? '', decision: 'REJECTED', note: 'كل سطور الكشف اتشطبت — آخر سبب: ' + note, revision: sub.revision, byUserId: req.user!.id },
      });
      await prisma.submission.update({ where: { id }, data: { reviewState: 'RETURNED', currentLevel: null, currentApproverId: null } });
    }
    res.status(201).json({ success: true, data: { ...rejection, id: rejection.id.toString(), submissionId: rejection.submissionId.toString(), byUserId: rejection.byUserId?.toString() ?? null }, fullyRejected, struck, total });
  }),
);

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
      const isApprover = (APPROVING_GRADES as readonly string[]).includes(me.grade);
      const mine = sub.currentApproverId === req.user!.id || (sub.currentApproverId === null && isApprover && me.grade === sub.currentLevel);
      if (!mine) throw AppError.forbidden('مش دورك في الاعتماد على الكشف ده دلوقتي');
    }
    if (sub.rowRejections.some((r) => r.revision === sub.revision && r.sheetIndex === sheetIndex && r.row === row)) throw AppError.validation('السطر ده مشطوب');

    const original = await storage.read(sub.file.filePath).catch(() => null);
    if (!original) throw AppError.validation('ملف الكشف الأصلي مش موجود على السيرفر');
    let wb: ExcelJS.Workbook;
    try {
      wb = new ExcelJS.Workbook();
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
    const edit = await prisma.submissionRowEdit.upsert({
      where: { submissionId_revision_sheetIndex_row: { submissionId: id, revision: sub.revision, sheetIndex, row } },
      create: { submissionId: id, revision: sub.revision, sheetIndex, row, ...data },
      update: data,
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
    const isApprover = !!me?.grade && (APPROVING_GRADES as readonly string[]).includes(me.grade);
    const mine = sub.currentApproverId === req.user!.id
      // كشف قديم من قبل نظام الإسناد: أي معتمد درجته = المستوى الحالي (السلوك القديم)
      || (sub.currentApproverId === null && isApprover && me!.grade === sub.currentLevel);
    if (!isAdmin && !mine) {
      throw AppError.forbidden('مش دورك في الاعتماد على الكشف ده دلوقتي');
    }

    // نحدد نتيجة القرار الأول (قبل ما نسجّل أي حاجة) — عشان الكشف الواقف عند مستوى اتشال من سلسلته ما يتبعتش قبل أوانه
    const chain = await resolveChainForUser(sub.userId, sub.projectId);
    let step = nextLevel(chain, sub.currentLevel);
    if (decision !== 'REJECTED' && step.kind === 'stuck') {
      if (!isAdmin) {
        throw AppError.validation('المستوى الحالي للكشف مش موجود في سلسلة اعتماد صاحبه (درجته أو المعتمدين المسندين له اتغيّروا) — الأدمن هو اللي يقدر يحرّكه');
      }
      // الأدمن بيفكّه: يكمّل من أول مستوى في السلسلة الحالية، ولو السلسلة فاضية خالص → خلصت
      step = chain[0] ? { kind: 'next', ...chain[0] } : { kind: 'done' };
    }

    // سجل القرار (تدقيق)
    await prisma.submissionReview.create({
      data: { submissionId: id, level: sub.currentLevel ?? '', decision, note: note.trim() || null, revision: sub.revision, byUserId: req.user!.id },
    });

    if (decision === 'REJECTED') {
      await prisma.submission.update({ where: { id }, data: { reviewState: 'RETURNED', currentLevel: null, currentApproverId: null } });
    } else if (step.kind === 'next') {
      // معتمد (بملاحظات أو بدون) → المستوى اللي بعده والشخص المسند له
      await prisma.submission.update({ where: { id }, data: { currentLevel: step.level, currentApproverId: step.approverId } });
    } else {
      // السلسلة خلصت → يتبعت لجوجل
      await prisma.submission.update({ where: { id }, data: { reviewState: 'SENT', currentLevel: null, currentApproverId: null } });
      void pushSubmissionToSheet(id); // ☁️ لأول مرة يوصل جوجل شيت
    }
    const fresh = await prisma.submission.findUnique({ where: { id }, include: SUB_INCLUDE });
    res.json({ success: true, data: shape(fresh as never) });
  }),
);
