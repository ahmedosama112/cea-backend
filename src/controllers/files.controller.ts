import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { storage } from '../services/storage';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

async function findOwnedFile(userId: bigint, id: bigint) {
  const file = await prisma.file.findFirst({ where: { id, userId } });
  if (!file) throw AppError.notFound('الملف غير موجود');
  return file;
}

// للقراءة فقط: مالك الملف، أو ملف مربوط كتوقيع في إعدادات حساب القارئ
// (الأدمن يرفع توقيعه ويربطه بحساب المهندس — المهندس يحتاج قراءته لطباعة الكشوف المعتمدة)
async function findReadableFile(userId: bigint, id: bigint) {
  const file = await prisma.file.findUnique({ where: { id } });
  if (!file) throw AppError.notFound('الملف غير موجود');
  if (file.userId === userId) return file;
  const settings = await prisma.accountSettings.findUnique({ where: { userId } });
  if (settings?.signatureFileId === id) return file;
  throw AppError.notFound('الملف غير موجود'); // 404 وليس 403 — عدم كشف وجود ملفات الآخرين
}

export const filesController = {
  // رفع صورة (توقيع أو صورة تقرير يومي) — multer يضعها في memory buffer
  upload: asyncHandler(async (req: Request, res: Response) => {
    const f = req.file;
    if (!f) throw AppError.validation('لم يتم إرفاق ملف');
    if (!ALLOWED_MIME.has(f.mimetype)) throw AppError.validation('نوع الملف غير مدعوم — الصور فقط (JPEG/PNG/WebP)');

    const originalName = (()=>{ try { const x = Buffer.from(f.originalname, 'latin1').toString('utf8'); return x.includes('�') ? f.originalname : x; } catch { return f.originalname; } })();
    const { storedPath } = await storage.save(f.buffer, originalName);
    const row = await prisma.file.create({
      data: {
        userId: req.user!.id,
        fileName: originalName,
        filePath: storedPath,
        mimeType: f.mimetype,
        fileSize: f.size,
      },
    });
    res.status(201).json({ success: true, data: row });
  }),

  meta: asyncHandler(async (req: Request, res: Response) => {
    const file = await findReadableFile(req.user!.id, BigInt(req.params.id));
    res.json({ success: true, data: file });
  }),

  // المحتوى الفعلي — دائمًا خلف access check، الملفات لا تُخدَّم statically أبدًا
  content: asyncHandler(async (req: Request, res: Response) => {
    const file = await findReadableFile(req.user!.id, BigInt(req.params.id));
    const buffer = await storage.read(file.filePath);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buffer);
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    const file = await findOwnedFile(req.user!.id, BigInt(req.params.id));
    // ملف مرتبط بتسليم كشف: حذفه يحذف التسليم نفسه (cascade) حتى لو معتمَد — ممنوع من هنا؛
    // مسار التسليمات هو الوحيد الذي يقرر متى يُسمح بالحذف (قبل المراجعة فقط)
    const linkedSubmission = await prisma.submission.findFirst({ where: { fileId: file.id }, select: { id: true } });
    if (linkedSubmission) throw AppError.forbidden('هذا الملف مرتبط بتسليم كشف — احذفه من شاشة الاعتمادات');
    const usedAsSignature = await prisma.accountSettings.findFirst({ where: { signatureFileId: file.id }, select: { userId: true } });
    if (usedAsSignature) throw AppError.forbidden('هذا الملف مستخدم كتوقيع — امسح التوقيع أولًا');
    await prisma.file.delete({ where: { id: file.id } });
    await storage.remove(file.filePath);
    res.json({ success: true, data: null });
  }),
};
