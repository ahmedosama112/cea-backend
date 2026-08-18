import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';

// إعدادات الحساب: PIN hash (نفس SHA-256 المحسوب في الواجهة حاليًا) + ملف التوقيع
// بديل حقلي pin_hash/engineer_signature اللذين كانا في cea_sync_meta

export const accountSettingsSchema = z.object({
  pinHash: z.string().trim().length(64, 'PIN hash يجب أن يكون SHA-256 hex (64 حرف)').nullable().optional(),
  signatureFileId: z.coerce.bigint().nullable().optional(),
});

export const accountController = {
  get: asyncHandler(async (req: Request, res: Response) => {
    const settings = await prisma.accountSettings.findUnique({ where: { userId: req.user!.id } });
    res.json({
      success: true,
      data: settings ?? { pinHash: null, signatureFileId: null },
    });
  }),

  // upsert جزئي — نفس فكرة pushMetaField في الواجهة الحالية (تحديث حقل واحد دون المساس بالباقي)
  update: asyncHandler(async (req: Request, res: Response) => {
    const { pinHash, signatureFileId } = req.body as { pinHash?: string | null; signatureFileId?: bigint | null };

    if (signatureFileId) {
      const file = await prisma.file.findFirst({ where: { id: signatureFileId, userId: req.user!.id } });
      if (!file) throw AppError.validation('ملف التوقيع غير موجود');
    }

    const data = {
      ...(pinHash !== undefined ? { pinHash } : {}),
      ...(signatureFileId !== undefined ? { signatureFileId } : {}),
    };
    const settings = await prisma.accountSettings.upsert({
      where: { userId: req.user!.id },
      create: { userId: req.user!.id, ...data },
      update: data,
    });
    res.json({ success: true, data: settings });
  }),
};
