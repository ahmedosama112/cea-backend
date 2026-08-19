import { Router } from 'express';
import { Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { storage } from '../services/storage';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { authenticate, requireRole } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { idParamSchema } from '../utils/crudFactory';

// multer بيفك اسم الملف كـ latin1 — أسماء عربية بتبقى mojibake؛ نرجّعها UTF-8
function fixFileName(name: string): string {
  try { const fixed = Buffer.from(name, 'latin1').toString('utf8'); return fixed.includes('�') ? name : fixed; } catch { return name; }
}

// تسليمات الكشوف المعتمدة — بديل Google Form:
// المهندس يبعت الكشف (ملف Excel + بياناته) بعد مراجعته والموافقة عليه،
// الأدمن يشوف كل التسليمات ويعتمد/يرفض بملاحظة، والمهندس يتابع حالة تسليماته.

export const submissionsRoutes = Router();
submissionsRoutes.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadMb * 1024 * 1024, files: 1 },
});

const XLSX_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream', // بعض المتصفحات بتبعت الـ blob كده
]);

const metaSchema = z.object({
  contractorName: z.string().trim().min(1).max(190),
  placeName: z.string().trim().max(190).optional().default(''),
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  weekEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  total: z.coerce.number().min(0),
  recordsCount: z.coerce.number().int().min(0),
  engineerNote: z.string().trim().max(500).optional().default(''),
});

const SUB_INCLUDE = {
  file: { select: { id: true, fileName: true, fileSize: true } },
  user: { select: { id: true, email: true, title: true } },
} as const;

function shape(s: Record<string, unknown> & { weekStart: Date; weekEnd: Date; createdAt: Date; reviewedAt: Date | null }) {
  return {
    ...s,
    weekStart: s.weekStart.toISOString().slice(0, 10),
    weekEnd: s.weekEnd.toISOString().slice(0, 10),
    createdAt: s.createdAt.toISOString(),
    reviewedAt: s.reviewedAt ? s.reviewedAt.toISOString() : null,
  };
}

// ── المهندس: إرسال كشف (ملف + بيانات) ──
submissionsRoutes.post(
  '/',
  upload.single('file'),
  asyncHandler(async (req: Request, res: Response) => {
    const f = req.file;
    if (!f) throw AppError.validation('لم يتم إرفاق ملف الكشف');
    if (!XLSX_MIME.has(f.mimetype) && !f.originalname.toLowerCase().endsWith('.xlsx')) throw AppError.validation('الملف لازم يكون Excel (.xlsx)');
    const meta = metaSchema.parse(req.body);

    const originalName = fixFileName(f.originalname);
    const { storedPath } = await storage.save(f.buffer, originalName);
    const file = await prisma.file.create({
      data: { userId: req.user!.id, fileName: originalName, filePath: storedPath, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileSize: f.size },
    });
    const sub = await prisma.submission.create({
      data: {
        userId: req.user!.id,
        fileId: file.id,
        contractorName: meta.contractorName,
        placeName: meta.placeName || null,
        weekStart: new Date(meta.weekStart),
        weekEnd: new Date(meta.weekEnd),
        total: meta.total,
        recordsCount: meta.recordsCount,
        engineerNote: meta.engineerNote || null,
      },
      include: SUB_INCLUDE,
    });
    res.status(201).json({ success: true, data: shape(sub as never) });
  }),
);

// ── المهندس: تسليماتي ──
submissionsRoutes.get(
  '/mine',
  asyncHandler(async (req: Request, res: Response) => {
    const rows = await prisma.submission.findMany({ where: { userId: req.user!.id }, include: SUB_INCLUDE, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json({ success: true, data: rows.map((r) => shape(r as never)) });
  }),
);

// ── تنزيل ملف تسليم (صاحبه أو الأدمن) ──
submissionsRoutes.get(
  '/:id/file',
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const sub = await prisma.submission.findUnique({ where: { id: BigInt(req.params.id) }, include: { file: true } });
    if (!sub) throw AppError.notFound('التسليم غير موجود');
    if (sub.userId !== req.user!.id && req.user!.role !== 'ADMIN') throw AppError.notFound('التسليم غير موجود');
    const buffer = await storage.read(sub.file.filePath);
    res.setHeader('Content-Type', sub.file.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(sub.file.fileName)}`);
    res.send(buffer);
  }),
);

// ── الأدمن: كل التسليمات (فلتر بالحالة) ──
submissionsRoutes.get(
  '/',
  requireRole('ADMIN'),
  validate({ query: z.object({ status: z.enum(['SUBMITTED', 'APPROVED', 'REJECTED']).optional(), limit: z.coerce.number().int().min(1).max(500).optional().default(200) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { status?: 'SUBMITTED' | 'APPROVED' | 'REJECTED'; limit: number };
    const rows = await prisma.submission.findMany({
      where: q.status ? { status: q.status } : {},
      include: SUB_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    res.json({ success: true, data: rows.map((r) => shape(r as never)) });
  }),
);

// ── الأدمن: اعتماد / رفض بملاحظة ──
submissionsRoutes.patch(
  '/:id/review',
  requireRole('ADMIN'),
  validate({ params: idParamSchema, body: z.object({ status: z.enum(['APPROVED', 'REJECTED', 'SUBMITTED']), reviewNote: z.string().trim().max(500).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = BigInt(req.params.id);
    const exists = await prisma.submission.findUnique({ where: { id } });
    if (!exists) throw AppError.notFound('التسليم غير موجود');
    const sub = await prisma.submission.update({
      where: { id },
      data: {
        status: req.body.status,
        reviewNote: req.body.reviewNote ?? null,
        reviewedById: req.body.status === 'SUBMITTED' ? null : req.user!.id,
        reviewedAt: req.body.status === 'SUBMITTED' ? null : new Date(),
      },
      include: SUB_INCLUDE,
    });
    res.json({ success: true, data: shape(sub as never) });
  }),
);

// ── المهندس: حذف تسليم لسه "مُرسَل" (قبل المراجعة) عشان يعيد إرساله ──
submissionsRoutes.delete(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const sub = await prisma.submission.findFirst({ where: { id: BigInt(req.params.id), userId: req.user!.id }, include: { file: true } });
    if (!sub) throw AppError.notFound('التسليم غير موجود');
    if (sub.status !== 'SUBMITTED') throw AppError.validation('لا يمكن حذف تسليم تمت مراجعته');
    await storage.remove(sub.file.filePath).catch(() => undefined);
    await prisma.submission.delete({ where: { id: sub.id } });
    await prisma.file.delete({ where: { id: sub.fileId } }).catch(() => undefined);
    res.json({ success: true, data: null });
  }),
);
