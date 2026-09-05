import { prisma } from '../config/prisma';
import { storage } from './storage';
import { pushSubmissionToGoogle } from './googleSheet';

// ═══════════ سلسلة اعتمادات المديرين (داخل التطبيق قبل جوجل شيت) ═══════════
// الكشف بيعدّي على المعتمدين المسندين لصاحبه بالترتيب؛ وبس بعد ما يخلص كلهم بيتبعت لجوجل شيت.
//
// السلسلة مش عامة — بتتحدد لكل مهندس على حدة:
//   1) درجته (grade) بتحدد المستويات المطلوبة (المصفوفة تحت)
//   2) الأعمدة approver_tl_id / approver_cm_id / approver_pm_id بتحدد الشخص نفسه في كل مستوى
// مستوى من غير شخص مسند بيتخطى (والأدمن بيشوف تحذير في كارت الحساب).

// الدرجات الخمس بالترتيب — ثابتة في الكود بقرار صاحب المشروع (بدل التعديل من app_config)
export const GRADES = ['junior', 'senior', 'team leader', 'construction manager', 'project manager'] as const;
export type Grade = (typeof GRADES)[number];

// الدرجات اللي بتعتمد (بترتيب السلسلة) — أعمدة جدول الاعتمادات في الواجهة هي دي
export const APPROVING_GRADES = ['team leader', 'construction manager', 'project manager'] as const;

// مين بيعتمد لمين — حسب درجة المرسِل
const CHAIN_BY_GRADE: Record<string, readonly string[]> = {
  junior: ['team leader', 'construction manager', 'project manager'],
  senior: ['team leader', 'construction manager', 'project manager'],
  'team leader': ['construction manager', 'project manager'],
  'construction manager': [],
  'project manager': [],
};

// عمود المعتمد المسند لكل مستوى
const APPROVER_FIELD: Record<string, 'approverTlId' | 'approverCmId' | 'approverPmId'> = {
  'team leader': 'approverTlId',
  'construction manager': 'approverCmId',
  'project manager': 'approverPmId',
};

export function isValidGrade(g: string): g is Grade {
  return (GRADES as readonly string[]).includes(g);
}

// المستويات المطلوبة لدرجة معيّنة (قبل حساب مين مسند) — للتحذيرات في إدارة الحسابات
export function requiredLevelsFor(grade: string): readonly string[] {
  return CHAIN_BY_GRADE[grade] ?? CHAIN_BY_GRADE.junior;
}

// قائمة المستويات المعرّفة (بالترتيب) — أعمدة الجدول في تاب الاعتمادات
export async function getApprovalLevels(): Promise<string[]> {
  return [...APPROVING_GRADES];
}

// مدير المشروع واحد ثابت في المشروع — لو مفيش إسناد صريح وفيه حساب واحد بس بدرجة project manager
// بنستخدمه تلقائيًا. لو فيه أكتر من واحد، الإسناد الصريح بقى إلزامي (وإلا المستوى يتخطى).
async function soleProjectManagerId(): Promise<bigint | null> {
  const pms = await prisma.user.findMany({ where: { grade: 'project manager' }, select: { id: true }, take: 2 });
  return pms.length === 1 ? pms[0].id : null;
}

// خانة واحدة في السلسلة: المستوى + الشخص المسند له
export type ChainSlot = { level: string; approverId: bigint };
export type ChainUser = { id: bigint; grade: string; approverTlId: bigint | null; approverCmId: bigint | null; approverPmId: bigint | null };

// بناء السلسلة من بيانات المستخدم (بلا استعلام) — عشان الطابور يحسب سلاسل كتير باستعلام واحد
export function buildChain(u: ChainUser, solePmId: bigint | null): ChainSlot[] {
  const slots: ChainSlot[] = [];
  for (const level of requiredLevelsFor(u.grade)) {
    let approverId = u[APPROVER_FIELD[level]] ?? null;
    if (!approverId && level === 'project manager') approverId = solePmId;
    // معتمد مسند لكن نفسه صاحب الكشف (مدير فريق بيبعت كشفه) — يتخطى بدل ما يعتمد لنفسه
    if (approverId && approverId !== u.id) slots.push({ level, approverId });
  }
  return slots;
}

// سلسلة كشوف مهندس معيّن: المستويات المطلوبة لدرجته، وبس اللي ليها معتمد مسند فعلًا
export async function resolveChainForUser(userId: bigint): Promise<ChainSlot[]> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, grade: true, approverTlId: true, approverCmId: true, approverPmId: true },
  });
  if (!u) return [];
  return buildChain(u, await soleProjectManagerId());
}

export { soleProjectManagerId };
// نتيجة الانتقال في السلسلة:
//  next  → فيه مستوى تالي     done → السلسلة خلصت (يتبعت لجوجل)
//  stuck → المستوى الحالي للكشف مش موجود في سلسلة صاحبه (درجته أو المعتمد المسند له اتغيّر والكشف واقف)
//          → الكشف يفضل IN_REVIEW معلّقًا ومايتبعتش قبل أوانه؛ الأدمن هو اللي بيفكه
export type ChainStep = { kind: 'next'; level: string; approverId: bigint } | { kind: 'done' } | { kind: 'stuck' };

export function nextLevel(chain: ChainSlot[], current: string | null): ChainStep {
  if (!current) return chain[0] ? { kind: 'next', ...chain[0] } : { kind: 'done' };
  const i = chain.findIndex((c) => c.level === current);
  if (i === -1) return { kind: 'stuck' };
  if (i + 1 >= chain.length) return { kind: 'done' };
  return { kind: 'next', ...chain[i + 1] };
}

// دفع الكشف فعليًا لجوجل شيت (بيقرأ الملف من التخزين) — يُستدعى لما السلسلة تخلص
export async function pushSubmissionToSheet(submissionId: bigint): Promise<void> {
  const sub = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      file: true,
      user: { select: { email: true, project: true } },
      reviews: { orderBy: { createdAt: 'asc' }, include: { byUser: { select: { email: true, title: true } } } },
    },
  });
  if (!sub) return;
  const buffer = await storage.read(sub.file.filePath).catch(() => null);
  if (!buffer) { console.error('[approval] ملف التسليم غير موجود عند الدفع لجوجل', submissionId.toString()); return; }
  await pushSubmissionToGoogle(sub.id, buffer, sub.file.fileName, sub.user.email.split('@')[0], sub.user.project ?? null, sub.site, approvalSummary(sub.reviews, sub.revision));
}

// ملخص سلسلة الاعتماد (للنسخة الحالية) — بيتكتب في خانة "سلسلة الاعتماد" في جوجل شيت لما الكشف ينزل
// مثال: "team leader: ✅ معتمد (ahmed) 03/09 22:10 | project manager: 📝 بملاحظات: راجع الإجمالي (mostafa) 03/09 22:40"
type ReviewRow = { level: string; decision: string; note: string | null; revision: number; createdAt: Date; byUser: { email: string; title: string | null } | null };
export function approvalSummary(reviews: ReviewRow[], revision: number): string {
  const label: Record<string, string> = { APPROVED: '✅ معتمد', APPROVED_NOTES: '📝 بملاحظات', REJECTED: '❌ مرفوض' };
  const fmt = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const parts = reviews
    .filter((r) => r.revision === revision)
    .map((r) => {
      const who = r.byUser ? (r.byUser.title || r.byUser.email.split('@')[0]) : '';
      return `${r.level}: ${label[r.decision] ?? r.decision}${r.note ? ': ' + r.note : ''}${who ? ' (' + who + ')' : ''} ${fmt(r.createdAt)}`;
    });
  if (!parts.length) return 'اتبعت مباشرة (مفيش معتمدين مضبوطين في التطبيق)';
  // كل اعتماد في سطر (الخانة في الشيت wrap) — أوضح من الفصل بـ |
  return (revision > 0 ? `نسخة ${revision}\n` : '') + parts.join('\n');
}

// بدء السلسلة لكشف جديد (أو إعادة إرسال): أول معتمد مسند لصاحب الكشف.
// لو مفيش أي معتمد مسند (أو درجته مش محتاجة اعتماد) → السلوك القديم: يتبعت لجوجل فورًا.
export async function startChain(submissionId: bigint): Promise<{ sentToSheet: boolean; firstLevel: string | null }> {
  const sub = await prisma.submission.findUnique({ where: { id: submissionId }, select: { userId: true } });
  if (!sub) return { sentToSheet: false, firstLevel: null };
  const chain = await resolveChainForUser(sub.userId);
  const first = chain[0];
  if (!first) {
    await prisma.submission.update({ where: { id: submissionId }, data: { reviewState: 'SENT', currentLevel: null, currentApproverId: null } });
    void pushSubmissionToSheet(submissionId);
    return { sentToSheet: true, firstLevel: null };
  }
  await prisma.submission.update({
    where: { id: submissionId },
    data: { reviewState: 'IN_REVIEW', currentLevel: first.level, currentApproverId: first.approverId },
  });
  return { sentToSheet: false, firstLevel: first.level };
}
