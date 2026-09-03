import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middlewares/validate';
import { idParamSchema } from '../utils/crudFactory';
import { getApprovalLevels, getActiveLevels, nextLevel, pushSubmissionToSheet } from '../services/approvalChain';

// ═══════════ اعتمادات المديرين — تبويب المراجعة والاعتماد ═══════════
// (authenticate + requireModule('approvals') مطبّقين في routes/index.ts)

export const approvalsRoutes = Router();

const SUB_INCLUDE = {
  file: { select: { id: true, fileName: true, fileSize: true } },
  user: { select: { id: true, email: true, title: true } },
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
// canAct = دور هذا المعتمد دلوقتي (المستوى الحالي = مستواه، أو أدمن)
approvalsRoutes.get(
  '/queue',
  asyncHandler(async (req: Request, res: Response) => {
    const me = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { approvalLevel: true } });
    const myLevel = me?.approvalLevel ?? null;
    const isAdmin = req.user!.role === 'ADMIN';
    // بنعرض اللي في المراجعة + آخر 40 اتبعت/اترفض (للسياق) — مرتبين بالأحدث
    const rows = await prisma.submission.findMany({
      where: { OR: [{ reviewState: 'IN_REVIEW' }, { reviewState: { in: ['RETURNED', 'SENT'] } }] },
      include: SUB_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({
      success: true,
      myLevel,
      data: rows.map((r) => ({
        ...shape(r as never),
        canAct: r.reviewState === 'IN_REVIEW' && (isAdmin || (myLevel != null && r.currentLevel === myLevel)),
      })),
    });
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

    // صلاحية: لازم المستوى الحالي يساوي مستوى المعتمد (الأدمن بيقدر يعتمد أي مستوى)
    const me = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { approvalLevel: true } });
    const isAdmin = req.user!.role === 'ADMIN';
    if (!isAdmin && (!me?.approvalLevel || me.approvalLevel !== sub.currentLevel)) {
      throw AppError.forbidden('مش دورك في الاعتماد على الكشف ده دلوقتي');
    }

    // سجل القرار (تدقيق)
    await prisma.submissionReview.create({
      data: { submissionId: id, level: sub.currentLevel ?? '', decision, note: note.trim() || null, revision: sub.revision, byUserId: req.user!.id },
    });

    if (decision === 'REJECTED') {
      await prisma.submission.update({ where: { id }, data: { reviewState: 'RETURNED', currentLevel: null } });
    } else {
      // معتمد (بملاحظات أو بدون) → المستوى اللي بعده؛ لو مفيش → السلسلة خلصت، يتبعت لجوجل
      const active = await getActiveLevels();
      const nl = nextLevel(active, sub.currentLevel);
      if (nl) {
        await prisma.submission.update({ where: { id }, data: { currentLevel: nl } });
      } else {
        await prisma.submission.update({ where: { id }, data: { reviewState: 'SENT', currentLevel: null } });
        void pushSubmissionToSheet(id); // ☁️ لأول مرة يوصل جوجل شيت
      }
    }
    const fresh = await prisma.submission.findUnique({ where: { id }, include: SUB_INCLUDE });
    res.json({ success: true, data: shape(fresh as never) });
  }),
);
