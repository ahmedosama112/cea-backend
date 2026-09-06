import { prisma } from '../config/prisma';
import { storage } from './storage';
import { pushSubmissionToGoogle } from './googleSheet';
import { stampSignatures, hasSignatureBox, LevelSignature } from './signStamp';

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

// مين بيعتمد لمين — حسب درجة المرسِل. الافتراضي تحت، والأدمن يقدر يعدّله من شاشة الإدارة
// (بيتخزن في app_config تحت مفتاح approvalMatrix).
const DEFAULT_MATRIX: Record<string, readonly string[]> = {
  junior: ['team leader', 'construction manager', 'project manager'],
  senior: ['team leader', 'construction manager', 'project manager'],
  'team leader': ['construction manager', 'project manager'],
  'construction manager': [],
  'project manager': [],
};
const MATRIX_KEY = 'approvalMatrix';

// كاش في الذاكرة: requiredLevelsFor لازم تفضل sync (بتتنادى جوه buildChain وفي حلقات)،
// فبنحمّل المصفوفة مرة عند الإقلاع وبنحدّثها بعد أي حفظ. السيرفر واحد فالكاش كافي.
let matrixCache: Record<string, string[]> = Object.fromEntries(Object.entries(DEFAULT_MATRIX).map(([k, v]) => [k, [...v]]));

// ترتيب السلم دايمًا محفوظ مهما كان ترتيب الاختيار — يمنع سلاسل معكوسة
function normalizeChain(levels: unknown): string[] {
  const set = new Set(Array.isArray(levels) ? levels.map((x) => String(x)) : []);
  return APPROVING_GRADES.filter((l) => set.has(l));
}

function parseMatrix(raw: string | null | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let parsed: Record<string, unknown> = {};
  try { parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; } catch { parsed = {}; }
  for (const g of GRADES) {
    out[g] = g in parsed ? normalizeChain(parsed[g]) : [...DEFAULT_MATRIX[g]];
  }
  return out;
}

// بتتنادى مرة عند إقلاع السيرفر
export async function loadApprovalMatrix(): Promise<Record<string, string[]>> {
  const row = await prisma.appConfig.findUnique({ where: { key: MATRIX_KEY } }).catch(() => null);
  matrixCache = parseMatrix(row?.value);
  return matrixCache;
}

export function getApprovalMatrix(): Record<string, string[]> {
  return matrixCache;
}

export async function setApprovalMatrix(input: Record<string, unknown>): Promise<Record<string, string[]>> {
  const clean: Record<string, string[]> = {};
  for (const g of GRADES) clean[g] = normalizeChain(input[g]);
  const value = JSON.stringify(clean);
  await prisma.appConfig.upsert({ where: { key: MATRIX_KEY }, update: { value }, create: { key: MATRIX_KEY, value } });
  matrixCache = clean;
  return clean;
}

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
  return matrixCache[grade] ?? matrixCache.junior ?? DEFAULT_MATRIX.junior;
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
      reviews: {
        orderBy: { createdAt: 'asc' },
        include: { byUser: { select: { email: true, title: true, accountSettings: { select: { signatureFile: true } } } } },
      },
    },
  });
  if (!sub) return;
  const toSend = await signedFileBuffer(submissionId);
  if (!toSend) { console.error('[approval] ملف التسليم غير موجود عند الدفع لجوجل', submissionId.toString()); return; }
  await pushSubmissionToGoogle(sub.id, toSend, sub.file.fileName, sub.user.email.split('@')[0], sub.user.project ?? null, sub.site, approvalSummary(sub.reviews, sub.revision));
}

// ملف الكشف **موقّعًا** بتوقيعات معتمدي النسخة الحالية — نفس النسخة اللي بتتبعت لجوجل.
// النسخة الموقّعة عابرة (بتتولّد عند الطلب من الأصل + سجل المراجعات) فما بتتخزنش، وده بيخلي
// المعاينة/التحميل بعد الاعتماد الكامل مطابقين دايمًا للي وصل الشيت.
// فشل الختم مايوقفش حاجة — بيرجع الأصل بلا توقيعات والخطأ بيتسجّل. null = الملف نفسه مش موجود.
export async function signedFileBuffer(submissionId: bigint): Promise<Buffer | null> {
  const sub = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      file: true,
      reviews: {
        orderBy: { createdAt: 'asc' },
        include: { byUser: { select: { accountSettings: { select: { signatureFile: true } } } } },
      },
    },
  });
  if (!sub) return null;
  const buffer = await storage.read(sub.file.filePath).catch(() => null);
  if (!buffer) return null;
  try {
    const sigs = await collectSignatures(sub.reviews, sub.revision);
    return sigs.length ? await stampSignatures(buffer, sigs) : buffer;
  } catch (e) {
    console.error('[approval] فشل ختم التوقيعات — استُخدمت النسخة بلا توقيعات', submissionId.toString(), (e as Error).message);
    return buffer;
  }
}

// توقيعات المستوى الواحد بتيجي من حساب المعتمد نفسه (نفس التوقيع اللي بيرفعه من شاشة "توقيع المهندس").
// بناخد آخر قرار اعتماد في النسخة الحالية لكل مستوى — الرفض مالوش توقيع طبعًا،
// والمستوى اللي معتمده مرفعش توقيع بيفضل بلوكه فاضي بالعنوان بس (زي ما كان بلوك العامل).
type SignatureReview = {
  level: string;
  decision: string;
  revision: number;
  byUser: { accountSettings: { signatureFile: { filePath: string; mimeType: string } | null } | null } | null;
};
export async function collectSignatures(reviews: SignatureReview[], revision: number): Promise<LevelSignature[]> {
  const byLevel = new Map<string, SignatureReview>();
  for (const r of reviews) {
    if (r.revision !== revision) continue;
    if (r.decision !== 'APPROVED' && r.decision !== 'APPROVED_NOTES') continue;
    if (!hasSignatureBox(r.level)) continue;
    byLevel.set(r.level, r); // آخر اعتماد على المستوى ده هو المعتمد
  }
  const out: LevelSignature[] = [];
  for (const [level, r] of byLevel) {
    const f = r.byUser?.accountSettings?.signatureFile;
    if (!f) continue;
    const image = await storage.read(f.filePath).catch(() => null);
    if (!image) { console.error('[approval] توقيع المعتمد مش موجود على السيرفر', level, f.filePath); continue; }
    out.push({ level, image, ext: f.mimeType.includes('jpeg') || f.mimeType.includes('jpg') ? 'jpeg' : 'png' });
  }
  return out;
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
