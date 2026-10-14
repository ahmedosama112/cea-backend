import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { storage } from '../services/storage';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

// (L4) الـ MIME جاي من العميل ومش موثوق — نتحقق من التوقيع الثنائي الفعلي لأول بايتات الملف
export function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return true; // WebP
  return false;
}
export function looksLikeXlsx(buf: Buffer): boolean {
  // xlsx = أرشيف ZIP — بيبدأ بـ PK
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

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
    if (!looksLikeImage(f.buffer)) throw AppError.validation('محتوى الملف ليس صورة حقيقية');

    const originalName = (()=>{ try { const x = Buffer.from(f.originalname, 'latin1').toString('utf8'); return x.includes('�') ? f.originalname : x; } catch { return f.originalname; } })();
    if (Array.from(originalName).length > 255) throw AppError.validation('اسم الملف أطول من الحد المسموح (255 حرفًا)');
    const { storedPath } = await storage.save(f.buffer, originalName);
    const row = await prisma.file.create({
      data: {
        userId: req.user!.id,
        fileName: originalName,
        filePath: storedPath,
        mimeType: f.mimetype,
        fileSize: f.size,
      },
    }).catch(async (error) => {
      await storage.remove(storedPath);
      throw error;
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
    const archived = await prisma.submissionRevision.findFirst({ where: { fileId: file.id }, select: { id: true } });
    if (archived) throw AppError.forbidden('هذا الملف مرتبط بنسخة مؤرشفة ولا يمكن حذفه');
    const usedAsSignature = await prisma.accountSettings.findFirst({ where: { signatureFileId: file.id }, select: { userId: true } });
    if (usedAsSignature) throw AppError.forbidden('هذا الملف مستخدم كتوقيع — امسح التوقيع أولًا');
    const deleted = await prisma.file.deleteMany({ where: {
      id: file.id, userId: req.user!.id,
      submissions: { none: {} }, submissionRevisions: { none: {} }, accountSettings: { is: null },
    } });
    if (!deleted.count) throw AppError.forbidden('الملف مرتبط ببيانات محفوظة ولا يمكن حذفه');
    await storage.remove(file.filePath);
    res.json({ success: true, data: null });
  }),
};
