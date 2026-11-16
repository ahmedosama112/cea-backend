import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';

const DEFAULT_PROJECT_ID = 1;

// ── إعدادات عامة: أسماء المواقع/المشاريع (يعدّلها الأدمن وتظهر في كل دروب داون "الموقع") ──
export const SITE_NAME_DEFAULTS: Record<string, string> = { site1Name: 'كومباوند جريني', site2Name: 'أزاليا' };

// أسماء المشروعين 1 و2 (القديمين) — بديل توافقي لـ {site1Name, site2Name} فوق جدول projects
// تُستخدم هنا وفي GET /api/config العام (لكل المستخدمين — الأسماء مش بيانات حساسة)
export async function readSiteNames(): Promise<Record<string, string>> {
  const rows = await prisma.project.findMany({ where: { id: { in: [1, 2] } } });
  const data = { ...SITE_NAME_DEFAULTS };
  for (const r of rows) data[r.id === 1 ? 'site1Name' : 'site2Name'] = r.name;
  return data;
}

// كل المشاريع (القديمة + الجديدة اللي الأدمن أضافها) — بترتيب الـid
export async function listProjects(): Promise<{ id: number; name: string; noApproval: boolean }[]> {
  return prisma.project.findMany({ orderBy: { id: 'asc' }, select: { id: true, name: true, noApproval: true } });
}

export async function projectName(id: number | null | undefined): Promise<string> {
  if (id == null) return '';
  const p = await prisma.project.findUnique({ where: { id }, select: { name: true } });
  return p?.name ?? 'مشروع ' + id;
}

// المشروع لازم يكون موجودًا فعلًا (أماكن/تسليمات بتشاور عليه بالـid)
export async function assertProjectExists(id: number | null | undefined): Promise<void> {
  if (id === null || id === undefined) return;
  const p = await prisma.project.findUnique({ where: { id }, select: { id: true } });
  if (!p) throw AppError.validation('المشروع غير موجود');
}

// (أمان — نوفمبر 2026) المهندس مايقدرش يختار مشروع مش بتاعه وقت إرسال الكشف: مشروع عليه noApproval
// كان بيفضّي سلسلة الاعتماد لأي حد يكتب رقمه. "بتاعه" = محمّل على حسابه (UserProject) أو عنده مكان في المشروع ده
// (الأماكن الأدمن بس اللي بيكتبها، و site=null معناها المشروع الافتراضي 1 — نفس اشتقاق الفرونت لـ projectId).
export async function userBelongsToProject(userId: bigint, projectId: number): Promise<boolean> {
  const up = await prisma.userProject.findUnique({ where: { userId_projectId: { userId, projectId } }, select: { id: true } });
  if (up) return true;
  const place = await prisma.place.findFirst({
    where: { userId, OR: projectId === DEFAULT_PROJECT_ID ? [{ site: projectId }, { site: null }] : [{ site: projectId }] },
    select: { id: true },
  });
  return !!place;
}

// مشروع عليه noApproval بيفضّي السلسلة — فمسموح بس لمهندس بتاع المشروع ده. أي مشروع تاني من غير UserProject
// بياخد سلسلة الحساب الافتراضية أصلًا، فمفيش تخطّي هناك ومش بنكسر الإرسال القديم.
export async function assertCanSubmitToProject(userId: bigint, projectId: number): Promise<void> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { noApproval: true } });
  if (p?.noApproval && !(await userBelongsToProject(userId, projectId))) {
    throw AppError.forbidden('المشروع ده مش محمّل على حسابك');
  }
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
  const conflictSiteName = await projectName(conflict.site);
  throw AppError.conflict(`المكان "${trimmed}" مسجّل بالفعل في مشروع ${conflictSiteName} — مينفعش يتكرر في مشروع تاني`);
}

// التحقق + التعميم قبل كتابة مكان — كل مكان بنفس الاسم (في كل الحسابات) لازم يبقى في نفس المشروع:
//  • مكان جديد (أو اسم اتغيّر) بمشروع مختلف عن مكان موجود بنفس الاسم → 409 (تحذير التكرار)
//  • تغيير مشروع مكان موجود (نفس الاسم) → بيتعمّم على كل الأماكن بنفس الاسم (تصحيح من مكان واحد)
//  • أول مرة يتحدد مشروع للاسم → الأماكن بنفس الاسم اللي من غير مشروع (عند المهندسين) بتاخده
// site = undefined → المشروع مش متبعت (تعديل اسم/ملاحظة بس) فبنتحقق بمشروع المكان الحالي.
export async function checkAndSyncPlaceSite(name: string, site: number | null | undefined, existing?: { id: bigint; name: string; site: number | null }): Promise<void> {
  const trimmed = name.trim();
  const effective = site !== undefined ? site : existing?.site ?? null;
  await assertProjectExists(effective);
  if (effective === null) return;
  const sameName = !!existing && existing.name.trim() === trimmed;
  if (sameName && site !== undefined && site !== existing!.site) {
    await prisma.place.updateMany({ where: { name: trimmed, id: { not: existing!.id } }, data: { site: effective } });
    return;
  }
  await assertPlaceSiteUnique(trimmed, effective, existing?.id);
  await prisma.place.updateMany({ where: { name: trimmed, site: null, ...(existing ? { id: { not: existing.id } } : {}) }, data: { site: effective } });
}
