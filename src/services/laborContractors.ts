import { prisma } from '../config/prisma';
import { normName } from './analytics.service';

// ═══════════ مقاولو العمالة (بالمياومة) ═══════════
// (2026-09-19) مقاولين بعينهم (يحددهم الأدمن — Contractor.isLabor) كشفهم لازم يبقى لوحده،
// من غير أي مقاول تاني معاه في نفس الكشف — عشان الشيت المخصص للعمالة يفضل نضيف.

// معجم مقاولي العمالة من حسابات الأدمن — بالاسم الموحّد (normName) عشان المقارنة تتجاهل فروق الكتابة
export async function laborNameSet(): Promise<Set<string>> {
  const rows = await prisma.contractor.findMany({
    where: { user: { role: 'ADMIN' }, isLabor: true },
    select: { name: true },
  });
  return new Set(rows.map((r) => normName(r.name)));
}

// كشف مقاولين عمالة: كل مقاوليه عليهم isLabor (checkLaborMix بيمنع خلطهم بغيرهم أصلًا).
// بيحدد نوع الكشف اللي بيتبعت لجوجل ('labor_contractor') عشان اسم الشيت المعتمد ياخد "مقاول_عمالة".
export async function isLaborSubmission(contractorName: string): Promise<boolean> {
  const names = contractorName.split(/،\s*/).map((n) => n.trim()).filter(Boolean);
  if (!names.length) return false;
  const labor = await laborNameSet();
  return names.every((n) => labor.has(normName(n)));
}

// تحقق قاعدة كشف العمالة وقت الإرسال/إعادة الإرسال — بيرجع رسالة الخطأ أو null لو الكشف سليم
export async function checkLaborMix(contractorName: string, placeName: string): Promise<string | null> {
  if (!placeName || !placeName.trim()) {
    return '⚠ لازم تختار مقاول ومكان — الكشف مايتبعتش بمقاول لوحده';
  }
  const names = contractorName.split(/،\s*/).map((n) => n.trim()).filter(Boolean);
  if (!names.length) return null;
  const labor = await laborNameSet();
  if (!labor.size) return null;
  const laborNames = names.filter((n) => labor.has(normName(n)));
  const otherNames = names.filter((n) => !labor.has(normName(n)));
  if (laborNames.length && otherNames.length) {
    return `⚠ مقاولين العمالة (${laborNames.join('، ')}) لازم يتبعتوا في كشف لوحدهم — من غير أي مقاول تاني`;
  }
  return null;
}

// تخزين أيام العمالة المعتمدة فعليًا لكشف معيّن (بديل الصفوف القديمة كاملة) — بيتصفّى على مقاولي
// العمالة بس (باقي الأسماء، لو موجودة، مالهاش لازمة هنا لأن checkLaborMix بيمنعها أصلًا في كشف عمالة).
// بتُستخدم من pushSubmissionToSheet (كل دفعة) ومن سكربت backfill-labor-days (استرجاع كشوف قديمة).
export async function saveLaborDays(
  submissionId: bigint,
  daysByContractor: Map<string, number | { days: number; dates?: Record<string, number> }>,
): Promise<void> {
  const labor = await laborNameSet();
  const rows = [...daysByContractor.entries()]
    .filter(([name]) => labor.has(normName(name)))
    .map(([name, v]) => {
      const days = typeof v === 'number' ? v : v.days;
      const dates = typeof v === 'number' ? null : v.dates && Object.keys(v.dates).length ? JSON.stringify(v.dates) : null;
      return { submissionId, contractorName: name, days, dates };
    });
  await prisma.$transaction([
    prisma.submissionLaborDays.deleteMany({ where: { submissionId } }),
    ...(rows.length ? [prisma.submissionLaborDays.createMany({ data: rows })] : []),
  ]);
}
