import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';

// ── إعدادات عامة: أسماء المواقع/المشاريع (يعدّلها الأدمن وتظهر في كل دروب داون "الموقع") ──
export const SITE_NAME_DEFAULTS: Record<string, string> = { site1Name: 'كومباوند جريني', site2Name: 'أزاليا' };

// تُستخدم هنا وفي GET /api/config العام (لكل المستخدمين — الأسماء مش بيانات حساسة)
export async function readSiteNames(): Promise<Record<string, string>> {
  const rows = await prisma.appConfig.findMany({ where: { key: { in: Object.keys(SITE_NAME_DEFAULTS) } } });
  const data = { ...SITE_NAME_DEFAULTS };
  for (const r of rows) data[r.key] = r.value;
  return data;
}


// نفس اسم المكان (بعد trim) مينفعش يبقى في مشروعين مختلفين عبر كل الحسابات.
// site = null/undefined → مفيش تحقق مطلوب (المكان لسه من غير مشروع).
export async function assertPlaceSiteUnique(name: string, site: number | null | undefined, excludeId?: bigint): Promise<void> {
  if (site === null || site === undefined) return;
  const trimmed = name.trim();
  const conflict = await prisma.place.findFirst({
    where: {
      name: trimmed,
      site: { not: null, notIn: [site] },
      ...(excludeId !== undefined ? { id: { not: excludeId } } : {}),
    },
  });
  if (!conflict) return;
  const siteNames = await readSiteNames();
  const conflictSiteName = conflict.site === 1 ? siteNames.site1Name : siteNames.site2Name;
  throw AppError.conflict(`المكان "${trimmed}" مسجّل بالفعل في مشروع ${conflictSiteName} — مينفعش يتكرر في مشروع تاني`);
}
