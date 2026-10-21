import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middlewares/validate';
import { requireWindow } from '../middlewares/windowGuard';
import { storage } from '../services/storage';
import { resolveChainForUser, pushSubmissionToSheet, prepareApprovalAccounting } from '../services/approvalChain';
import { assertOpen, audit, buildDraft, completed, conflict, RowEditInput } from '../services/corrections';

const id = z.object({ id: z.coerce.bigint().positive() });
const editSchema = z.object({
  taskId: z.string().regex(/^\d+$/), qty: z.string().max(20).optional(), price: z.string().max(20).optional(),
  notes: z.string().max(500).optional(), timeFrom: z.string().max(5).optional(), timeTo: z.string().max(5).optional(),
});
const listSchema = z.object({
  state: z.enum(['OPEN', 'RESENT', 'RESOLVED']).default('OPEN'),
  page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(30),
  ownerSearch: z.string().trim().max(100).optional(),
  ownerId: z.coerce.bigint().positive().optional(), projectId: z.coerce.number().int().optional(),
  minAgeHours: z.coerce.number().min(0).max(87600).default(0), staleHours: z.coerce.number().min(1).max(8760).default(48),
});

export function correctionList(manager: boolean) {
  return [validate({ query: listSchema }), asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof listSchema>;
    const where: Prisma.CorrectionTaskWhereInput = {
      state: q.state,
      ownerId: manager ? q.ownerId : req.user!.id,
      source: { ...(q.projectId !== undefined ? { projectId: q.projectId } : {}), ...(manager && q.ownerSearch ? { user: { OR: [{ displayName: { contains: q.ownerSearch } }, { email: { contains: q.ownerSearch } }] } } : {}) },
      ...(q.minAgeHours ? { requestedAt: { lte: new Date(Date.now() - q.minAgeHours * 3600000) } } : {}),
      // Full rejection supersedes its own partial tasks until the full resend succeeds.
      ...(q.state === 'OPEN' ? { NOT: { row: { gt: 0 }, source: { reviewState: 'RETURNED' } } } : {}),
    };
    const countWhere = { ownerId: manager ? q.ownerId : req.user!.id };
    const [total, rows, openSubmissions, openDays, projects] = await Promise.all([
      prisma.correctionTask.count({ where }),
      prisma.correctionTask.findMany({ where, orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit,
        include: { source: { select: { id: true, revision: true, reviewState: true, contractorName: true, kind: true, site: true, projectId: true,
          user: { select: { id: true, email: true, displayName: true } } } },
          links: { orderBy: { createdAt: 'desc' }, take: 1, select: { replacementId: true, revision: true, sheetIndex: true, row: true } },
          events: { orderBy: { createdAt: 'desc' }, take: 1, select: { actorId: true, action: true, createdAt: true, detail: true } } } }),
      prisma.correctionTask.count({ where: { ...countWhere, state: 'OPEN', row: 0 } }),
      prisma.correctionTask.count({ where: { ...countWhere, state: 'OPEN', row: { gt: 0 }, source: { reviewState: { not: 'RETURNED' } } } }),
      prisma.project.findMany({ select: { id: true, name: true } }),
    ]);
    const people = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((t) => t.requestedById ? [t.requestedById] : []))] } }, select: { id: true, email: true, displayName: true } });
    res.json({ success: true, data: rows.map((t) => ({ ...t, requestedByName: people.find((u) => u.id === t.requestedById)?.displayName || people.find((u) => u.id === t.requestedById)?.email || null, projectName: projects.find((p) => p.id === t.source.projectId)?.name ?? null,
      ageHours: Math.floor((Date.now() - t.requestedAt.getTime()) / 3600000), stale: Date.now() - t.requestedAt.getTime() >= q.staleHours * 3600000,
      canCorrect: !manager && t.state === 'OPEN' && t.row > 0 && t.source.reviewState === 'SENT',
    })), total, page: q.page, limit: q.limit, summary: { submissions: openSubmissions, days: openDays } });
  })];
}

export const correctionsRoutes = Router();
correctionsRoutes.get('/', ...correctionList(false));
correctionsRoutes.post('/drafts', validate({ body: z.object({ taskIds: z.array(z.string().regex(/^\d+$/)).min(1).max(100) }) }), asyncHandler(async (req, res) => {
  const ids = [...new Set(req.body.taskIds as string[])].map(BigInt);
  const tasks = await prisma.correctionTask.findMany({ where: { id: { in: ids }, ownerId: req.user!.id } });
  if (tasks.length !== ids.length) throw AppError.notFound('الأيام غير موجودة');
  const first = tasks[0];
  if (tasks.some((t) => t.sourceId !== first.sourceId || t.sourceRevision !== first.sourceRevision)) throw AppError.validation('اختر أيامًا من كشف أصلي واحد ونسخة واحدة');
  // Exercise the source file before saving a draft. Read failures must remain visible.
  await buildDraft(first.sourceId, first.sourceRevision, ids, []);
  const draft = await prisma.$transaction(async (tx) => {
    await assertOpen(tx, ids, first.sourceId, req.user!.id);
    const existing = await tx.correctionDraft.findFirst({ where: { sourceId: first.sourceId, sourceRevision: first.sourceRevision, ownerId: req.user!.id, submittedId: null } });
    if (existing) throw AppError.conflict(`توجد مسودة محفوظة لهذا الكشف (#${existing.id}) — افتحها أو احذفها أولًا`);
    return tx.correctionDraft.create({ data: { sourceId: first.sourceId, sourceRevision: first.sourceRevision, ownerId: req.user!.id, taskIds: ids.map(String), edits: [] } });
  });
  res.status(201).json({ success: true, data: draft });
}));
correctionsRoutes.get('/drafts', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await prisma.correctionDraft.findMany({ where: { ownerId: req.user!.id, submittedId: null }, orderBy: { createdAt: 'desc' }, take: 100 }) });
}));
async function ownDraft(draftId: bigint, ownerId: bigint) {
  const draft = await prisma.correctionDraft.findFirst({ where: { id: draftId, ownerId } });
  if (!draft) throw AppError.notFound('المسودة غير موجودة');
  return draft;
}
correctionsRoutes.get('/drafts/:id', validate({ params: id }), asyncHandler(async (req, res) => {
  const draft = await ownDraft(BigInt(req.params.id), req.user!.id);
  if (draft.submittedId) { res.json({ success: true, data: { ...draft, rows: [], total: null } }); return; }
  const built = await buildDraft(draft.sourceId, draft.sourceRevision, (draft.taskIds as string[]).map(BigInt), draft.edits as RowEditInput[]);
  res.json({ success: true, data: { ...draft, rows: built.details, total: built.total } });
}));
correctionsRoutes.patch('/drafts/:id', validate({ params: id, body: z.object({ version: z.number().int().min(0), edits: z.array(editSchema).max(100) }) }), asyncHandler(async (req, res) => {
  const draft = await ownDraft(BigInt(req.params.id), req.user!.id);
  const edits = req.body.edits as RowEditInput[];
  if (new Set(edits.map((e) => e.taskId)).size !== edits.length || edits.some((e) => !(draft.taskIds as string[]).includes(e.taskId))) throw AppError.validation('تعديلات الأيام غير صحيحة');
  await buildDraft(draft.sourceId, draft.sourceRevision, (draft.taskIds as string[]).map(BigInt), edits);
  const updated = await prisma.correctionDraft.updateMany({ where: { id: draft.id, ownerId: req.user!.id, version: req.body.version, submittedId: null }, data: { edits: edits as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
  if (!updated.count) throw conflict();
  res.json({ success: true, data: { version: req.body.version + 1 } });
}));
correctionsRoutes.delete('/drafts/:id', validate({ params: id }), asyncHandler(async (req, res) => {
  const draft = await ownDraft(BigInt(req.params.id), req.user!.id);
  await prisma.$transaction(async (tx) => {
    // Same source lock as submit, so delete cannot race with submission.
    await tx.$queryRaw`SELECT id FROM submissions WHERE id = ${draft.sourceId} FOR UPDATE`;
    const deleted = await tx.correctionDraft.deleteMany({ where: { id: draft.id, ownerId: req.user!.id, submittedId: null } });
    if (!deleted.count) throw conflict();
  });
  res.json({ success: true });
}));
correctionsRoutes.get('/drafts/:id/file', validate({ params: id }), asyncHandler(async (req, res) => {
  const draft = await ownDraft(BigInt(req.params.id), req.user!.id);
  const built = await buildDraft(draft.sourceId, draft.sourceRevision, (draft.taskIds as string[]).map(BigInt), draft.edits as RowEditInput[]);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.send(built.buffer);
}));
correctionsRoutes.post('/drafts/:id/submit', requireWindow('submit'), validate({ params: id, body: z.object({ version: z.number().int().min(0) }) }), asyncHandler(async (req, res) => {
  const draft = await ownDraft(BigInt(req.params.id), req.user!.id);
  if (draft.submittedId) { res.json({ success: true, data: { id: draft.submittedId, alreadySubmitted: true } }); return; }
  if (draft.version !== req.body.version) throw conflict();
  const ids = (draft.taskIds as string[]).map(BigInt);
  const built = await buildDraft(draft.sourceId, draft.sourceRevision, ids, draft.edits as RowEditInput[]);
  // Resolve by original project, never the engineer's newly selected project/site.
  const originalAccounting = built.sub.kind === 'labor' && built.sub.approvedTotal == null ? await prepareApprovalAccounting(built.sub.id) : null;
  if (built.sub.kind === 'labor' && built.sub.approvedTotal == null && !originalAccounting) throw AppError.notFound('تعذّر حساب الأصل المعتمد — راجع المسؤول قبل إرسال التصحيح');
  const chain = await resolveChainForUser(req.user!.id, built.sub.projectId);
  const first = chain[0];
  const { storedPath } = await storage.save(built.buffer, `correction-${draft.id}.xlsx`);
  let sentId: bigint;
  try {
    sentId = await prisma.$transaction(async (tx) => {
      const source = await assertOpen(tx, ids, draft.sourceId, req.user!.id);
      if (source.revision !== built.sub.revision) throw conflict();
      if (originalAccounting && source.approvedTotal == null) {
        await tx.submission.update({ where: { id: source.id }, data: { approvedTotal: originalAccounting.total } });
        await tx.submissionLaborDays.deleteMany({ where: { submissionId: source.id } });
        if (originalAccounting.days.length) await tx.submissionLaborDays.createMany({ data: originalAccounting.days.map((d) => ({ ...d, submissionId: source.id })) });
      }
      const claimed = await tx.correctionDraft.updateMany({ where: { id: draft.id, ownerId: req.user!.id, submittedId: null, version: draft.version }, data: { version: { increment: 1 } } });
      if (!claimed.count) throw conflict();
      const file = await tx.file.create({ data: { userId: req.user!.id, fileName: `correction-${draft.id}.xlsx`, filePath: storedPath, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileSize: built.buffer.length } });
      const sub = await tx.submission.create({ data: {
        userId: req.user!.id, fileId: file.id, contractorName: built.sub.contractorName, placeName: built.sub.placeName,
        weekStart: built.sub.weekStart, weekEnd: built.sub.weekEnd, kind: built.sub.kind, site: built.sub.site, projectId: built.sub.projectId,
        total: built.total, approvedTotal: !first && built.sub.kind === 'labor' ? built.total : null, recordsCount: built.recordsCount, engineerNote: `تصحيح كشف #${draft.sourceId} نسخة ${draft.sourceRevision}`,
        reviewState: first ? 'IN_REVIEW' : 'SENT', currentLevel: first?.level ?? null, currentApproverId: first?.approverId ?? null,
      } });
      for (const map of built.mapping) {
        await tx.correctionLink.create({ data: { taskId: map.taskId, activeTaskId: map.taskId, replacementId: sub.id, revision: 0, sheetIndex: map.sheetIndex, row: map.row } });
        const changed = await tx.correctionTask.updateMany({ where: { id: map.taskId, state: 'OPEN' }, data: { state: 'RESENT', resentAt: new Date() } });
        if (!changed.count) throw conflict();
        await audit(tx, map.taskId, req.user!.id, 'RESENT', `submission ${sub.id} revision 0`);
      }
      await tx.correctionDraft.update({ where: { id: draft.id }, data: { submittedId: sub.id } });
      if (!first) await completed(tx, sub, req.user!.id);
      return sub.id;
    });
  } catch (error) { await storage.remove(storedPath); throw error; }
  if (!first) void pushSubmissionToSheet(sentId).catch(() => console.error('[approval] Google sync failed; approval remains recorded'));
  res.status(201).json({ success: true, data: { id: sentId } });
}));
