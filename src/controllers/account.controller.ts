import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { ALL_MODULES, ALL_FEATURES, normalizeModules, normalizeFeatures } from '../utils/modules';
import { invalidateModulesCache } from '../middlewares/moduleGuard';

// إعدادات الحساب: PIN hash + ملف التوقيع + الوحدات المفعّلة (يديرها الأدمن)

export const accountSettingsSchema = z.object({
  pinHash: z.string().trim().length(64, 'PIN hash يجب أن يكون SHA-256 hex (64 حرف)').nullable().optional(),
  signatureFileId: z.coerce.bigint().nullable().optional(),
  enabledModules: z.array(z.enum(ALL_MODULES)).optional(),
  enabledFeatures: z.array(z.enum(ALL_FEATURES.map((f) => f.key) as [string, ...string[]])).optional(),
});

// شكل الاستجابة الموحد — enabledModules دايمًا مصفوفة (الافتراضي لو null)
export function serializeSettings(s: { pinHash?: string | null; signatureFileId?: bigint | null; enabledModules?: unknown; enabledFeatures?: unknown } | null) {
  return {
    pinHash: s?.pinHash ?? null,
    signatureFileId: s?.signatureFileId ?? null,
    enabledModules: normalizeModules(s?.enabledModules),
    enabledFeatures: normalizeFeatures(s?.enabledFeatures),
  };
}

// upsert جزئي مشترك — يستخدمه المستخدم (لنفسه) والأدمن (لأي حساب)
export async function upsertSettings(
  targetUserId: bigint,
  body: { pinHash?: string | null; signatureFileId?: bigint | null; enabledModules?: string[]; enabledFeatures?: string[] },
  allowedFileOwners: bigint[],
) {
  if (body.signatureFileId) {
    const file = await prisma.file.findFirst({ where: { id: body.signatureFileId, userId: { in: allowedFileOwners } } });
    if (!file) throw AppError.validation('ملف التوقيع غير موجود');
  }
  const data = {
    ...(body.pinHash !== undefined ? { pinHash: body.pinHash } : {}),
    ...(body.signatureFileId !== undefined ? { signatureFileId: body.signatureFileId } : {}),
    ...(body.enabledModules !== undefined ? { enabledModules: normalizeModules(body.enabledModules) } : {}),
    ...(body.enabledFeatures !== undefined ? { enabledFeatures: normalizeFeatures(body.enabledFeatures) } : {}),
  };
  const settings = await prisma.accountSettings.upsert({
    where: { userId: targetUserId },
    create: { userId: targetUserId, ...data },
    update: data,
  });
  if (body.enabledModules !== undefined) invalidateModulesCache(targetUserId);
  return serializeSettings(settings);
}

export const accountController = {
  get: asyncHandler(async (req: Request, res: Response) => {
    const settings = await prisma.accountSettings.findUnique({ where: { userId: req.user!.id } });
    const data = serializeSettings(settings);
    // الأدمن يشوف كل الوحدات دايمًا (هو اللي يدير التفعيل) — إلا لو حدد لنفسه قائمة صراحةً
    if (req.user!.role === 'ADMIN' && !Array.isArray(settings?.enabledModules)) data.enabledModules = [...ALL_MODULES];
    if (req.user!.role === 'ADMIN' && !Array.isArray(settings?.enabledFeatures)) data.enabledFeatures = ALL_FEATURES.map((f) => f.key);
    res.json({ success: true, data });
  }),

  // الأدمن فقط (الراوت محمي بـ requireRole) — لنفسه
  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await upsertSettings(req.user!.id, req.body, [req.user!.id]);
    res.json({ success: true, data });
  }),
};
