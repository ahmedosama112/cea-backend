import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middlewares/validate';
import { idParamSchema } from '../utils/crudFactory';
import { getApprovalLevels, APPROVING_GRADES, buildChain, nextLevel, resolveChainForUser, soleProjectManagerId, pushSubmissionToSheet, signedFileBuffer } from '../services/approvalChain';
import { storage } from '../services/storage';

// ═══════════ اعتمادات المديرين — تبويب المراجعة والاعتماد ═══════════
// (authenticate + requireModule('approvals') مطبّقين في routes/index.ts)

export const approvalsRoutes = Router();

const SUB_INCLUDE = {
  file: { select: { id: true, fileName: true, fileSize: true } },
  user: { select: { id: true, email: true, title: true, grade: true, approverTlId: true, approverCmId: true, approverPmId: true } },
  reviews: { orderBy: { createdAt: 'asc' as const }, include: { byUser: { select: { email: true, title: true } } } },
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
    // نطاق المعتمد: مهندسينه المسندين له + أي كشف مسند له شخصيًا
    // + الكشوف القديمة (قبل نظام الإسناد، current_approver_id = NULL) اللي واقفة عند مستوى درجته
    const scope = isAdmin
      ? {}
      : {
        OR: [
          { user: { OR: [{ approverTlId: myId }, { approverCmId: myId }, { approverPmId: myId }] } },
          { currentApproverId: myId },
          // كشوف اعتمدها/رفضها بالفعل — تفضل ظاهرة له في نافذة الـ 7 أيام حتى بعد ما تكمل السلسلة
          { reviews: { some: { byUserId: myId } } },
          ...(isApprover ? [{ currentApproverId: null, currentLevel: myLevel }] : []),
        ],
      };
    const rows = await prisma.submission.findMany({
      where: { AND: [stateFilter, scope] },
      include: SUB_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const solePmId = await soleProjectManagerId();
    res.json({
      success: true,
      myLevel,
      // المستويات المعتمِدة بالترتيب (أعمدة الجدول)
      activeLevels: [...APPROVING_GRADES],
      data: rows.map((r) => {
        const chain = buildChain(r.user as never, solePmId);
        const inChain = chain.some((c) => c.level === r.currentLevel);
        return {
          ...shape(r as never),
          // سلسلة الكشف ده تحديدًا (مستويات صاحبه) — الواجهة بتستخدمها للأعمدة الفاضية والمتخطاة
          chain: chain.map((c) => c.level),
          // آخر مستوى في سلسلته → رسالة "بعد اعتمادك الكشف هيتبعت للتوقيع"
          isLast: r.reviewState === 'IN_REVIEW' && inChain && chain[chain.length - 1]?.level === r.currentLevel,
          // الكشف واقف عند مستوى مش في سلسلة صاحبه (درجته أو إسناده اتغيّر) → الأدمن بس اللي يحرّكه
          isStuck: r.reviewState === 'IN_REVIEW' && !inChain,
          // دور المعتمد ده دلوقتي: الكشف مسند له، أو كشف قديم واقف عند مستوى درجته
          canAct: r.reviewState === 'IN_REVIEW'
            && (isAdmin
              || r.currentApproverId === myId
              || (r.currentApproverId === null && isApprover && r.currentLevel === myLevel)),
        };
      }),
    });
  }),
);

// ملف الكشف للمراجعة/التحميل من تاب الاعتمادات — لأي حساب عنده وحدة approvals (المعتمدين مش أصحاب الملف ولا أدمن،
// فمسار /submissions/:id/file بيرفضهم: محمي بوحدة submissions وبشرط صاحب الملف/أدمن)
// النطاق (فحص أمني 6 سبتمبر 2026): كان أي حساب عنده الوحدة يقدر ينزّل أي كشف بمعرّفه (IDOR).
// بقى مقصور على: الأدمن، أو الكشف مسند له، أو صاحب الكشف من مهندسيه المسندين، أو اعتمده/رفضه قبل كده،
// أو كشف قديم (بلا إسناد) واقف عند مستوى درجته — نفس نطاق الطابور بلا نافذة زمنية.
approvalsRoutes.get(
  '/:id/file',
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const sub = await prisma.submission.findUnique({ where: { id: BigInt(req.params.id) }, include: { file: true, user: { select: { approverTlId: true, approverCmId: true, approverPmId: true } }, reviews: { select: { byUserId: true } } } });
    if (!sub) throw AppError.notFound('الكشف غير موجود');
    if (req.user!.role !== 'ADMIN') {
      const myId = req.user!.id;
      const me = await prisma.user.findUnique({ where: { id: myId }, select: { grade: true } });
      const inScope = sub.currentApproverId === myId
        || sub.user.approverTlId === myId || sub.user.approverCmId === myId || sub.user.approverPmId === myId
        || sub.reviews.some((r) => r.byUserId === myId)
        || (sub.currentApproverId === null && !!me?.grade && (APPROVING_GRADES as readonly string[]).includes(me.grade) && sub.currentLevel === me.grade);
      if (!inScope) throw AppError.notFound('الكشف غير موجود');
    }
    // بعد اكتمال السلسلة (SENT) المعاينة/التحميل بيرجّعوا النسخة **الموقّعة** — نفس اللي وصلت جوجل شيت.
    // أثناء المراجعة بيرجّع الأصل زي ما بعته المهندس (التوقيعات لسه ما اكتملتش).
    const buffer = sub.reviewState === 'SENT'
      ? await signedFileBuffer(sub.id)
      : await storage.read(sub.file.filePath).catch(() => null);
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

// قرار اعتماد: معتمد بدون ملاحظات / معتمد بملاحظات / مرفوض بملاحظات
approvalsRoutes.post(
  '/:id/decide',
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
    const isAdmin = req.user!.role === 'ADMIN';
    const isApprover = !!me?.grade && (APPROVING_GRADES as readonly string[]).includes(me.grade);
    const mine = sub.currentApproverId === req.user!.id
      // كشف قديم من قبل نظام الإسناد: أي معتمد درجته = المستوى الحالي (السلوك القديم)
      || (sub.currentApproverId === null && isApprover && me!.grade === sub.currentLevel);
    if (!isAdmin && !mine) {
      throw AppError.forbidden('مش دورك في الاعتماد على الكشف ده دلوقتي');
    }

    // نحدد نتيجة القرار الأول (قبل ما نسجّل أي حاجة) — عشان الكشف الواقف عند مستوى اتشال من سلسلته ما يتبعتش قبل أوانه
    const chain = await resolveChainForUser(sub.userId);
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
