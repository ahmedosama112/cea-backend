import { prisma } from '../config/prisma';
import { storage } from './storage';
import { pushSubmissionToGoogle } from './googleSheet';
import { stampSignatures, hasSignatureBox, LevelSignature } from './signStamp';
import { applyRowRejections, applyRowEdits, workbookLaborTotal, workbookLaborDaysDetail, Kind, RejectMode, RowEdit } from './rowReject';
import { saveLaborDays } from './laborContractors';

// ═══════════ سلسلة اعتمادات المديرين (داخل التطبيق قبل جوجل شيت) ═══════════
// الكشف بيعدّي على المعتمدين المسندين لصاحبه بالترتيب؛ وبس بعد ما يخلص كلهم بيتبعت لجوجل شيت.
//
// السلسلة مش عامة — بتتحدد لكل مهندس على حدة:
//   1) درجته (grade) بتحدد المستويات المطلوبة (المصفوفة تحت)
//   2) الأعمدة approver_tl_id / approver_cm_id / approver_pm_id بتحدد الشخص نفسه في كل مستوى
// مستوى من غير شخص مسند بيتخطى (والأدمن بيشوف تحذير في كارت الحساب).

// الدرجات الخمس بالترتيب — ثابتة في الكود بقرار صاحب المشروع (بدل التعديل من app_config)
// 'viewer' مش رتبة في السلم — حساب بيشوف كل الكشوف وملفاتها بس مايعتمدش ولا يترفض أبدًا (مقصود آخر القائمة)
export const GRADES = ['junior', 'senior', 'team leader', 'construction manager', 'project manager', 'viewer'] as const;
export type Grade = (typeof GRADES)[number];

// الدرجات اللي بتعتمد (بترتيب السلسلة) — أعمدة جدول الاعتمادات في الواجهة هي دي. 'viewer' متعمّد مش موجود هنا.
export const APPROVING_GRADES = ['team leader', 'construction manager', 'project manager'] as const;

// مين بيعتمد لمين — حسب درجة المرسِل. الافتراضي تحت، والأدمن يقدر يعدّله من شاشة الإدارة
// (بيتخزن في app_config تحت مفتاح approvalMatrix).
const DEFAULT_MATRIX: Record<string, readonly string[]> = {
  junior: ['team leader', 'construction manager', 'project manager'],
  senior: ['team leader', 'construction manager', 'project manager'],
  'team leader': ['construction manager', 'project manager'],
  'construction manager': [],
  'project manager': [],
  viewer: [],
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

// سلسلة كشوف مهندس معيّن: المستويات المطلوبة لدرجته، وبس اللي ليها معتمد مسند فعلًا.
// projectId: لو محدد وموجود مشروع محمّل على الحساب بالـid ده، السلسلة بتاخد معتمدي المشروع ده
// (approver_tl/cm/pm_id بتاعة UserProject) بدل المعتمدين الافتراضيين على الحساب.
export async function resolveChainForUser(userId: bigint, projectId?: number | null): Promise<ChainSlot[]> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, grade: true, approverTlId: true, approverCmId: true, approverPmId: true },
  });
  if (!u) return [];
  if (projectId != null) {
    const up = await prisma.userProject.findUnique({ where: { userId_projectId: { userId, projectId } } });
    if (up) {
      return buildChain(
        { id: u.id, grade: u.grade, approverTlId: up.approverTlId, approverCmId: up.approverCmId, approverPmId: up.approverPmId },
        await soleProjectManagerId(),
      );
    }
  }
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
      user: { select: { email: true, displayName: true, project: true } },
      reviews: {
        orderBy: { createdAt: 'asc' },
        include: { byUser: { select: { email: true, displayName: true, title: true, accountSettings: { select: { signatureFile: true } } } } },
      },
      rowRejections: { orderBy: { createdAt: 'asc' } },
      rowEdits: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!sub) return;
  const toSend = await signedFileBuffer(submissionId);
  if (!toSend) { console.error('[approval] ملف التسليم غير موجود عند الدفع لجوجل', submissionId.toString()); return; }
  // ده الرقم اللي وصل الشيت فعلًا بعد أي شطب — Submission.total بيفضل زي ما هو كسجل لما المهندس بعته.
  // بيتحفظ في كل دفعة (مش بس لما فيه شطب) عشان العمود يفضل دايمًا فيه اللي اتبعت فعلًا. فشل هنا ما بيوقفش الدفع.
  if (sub.kind === 'labor') {
    try {
      const real = await workbookLaborTotal(toSend);
      if (real != null) await prisma.submission.update({ where: { id: submissionId }, data: { approvedTotal: real } });
    } catch (e) {
      console.error('[approval] فشل حساب الإجمالي الفعلي', submissionId.toString(), (e as Error).message);
    }
    // أيام العمالة المعتمدة فعليًا لكل مقاول عمالة — لتقرير "مقاولين العمالة" (قبل/بعد الاعتماد). فشل هنا مايوقفش الدفع.
    try {
      const days = await workbookLaborDaysDetail(toSend);
      if (days) await saveLaborDays(submissionId, days);
    } catch (e) {
      console.error('[approval] فشل حساب أيام العمالة المعتمدة', submissionId.toString(), (e as Error).message);
    }
  }
  // اسم المهندس في الشيت: الاسم بالعربي لو محدد، وإلا أول الإيميل (زي زمان)
  await pushSubmissionToGoogle(sub.id, toSend, sub.file.fileName, sub.user.displayName || sub.user.email.split('@')[0], sub.user.project ?? null, sub.site, approvalSummary(sub.reviews, sub.revision, sub.rowRejections, sub.rowEdits));
}

// ملف الكشف **موقّعًا** بتوقيعات معتمدي النسخة الحالية — نفس النسخة اللي بتتبعت لجوجل.
// النسخة الموقّعة عابرة (بتتولّد عند الطلب من الأصل + سجل المراجعات) فما بتتخزنش، وده بيخلي
// المعاينة/التحميل بعد الاعتماد الكامل مطابقين دايمًا للي وصل الشيت.
// فشل الختم مايوقفش حاجة — بيرجع الأصل بلا توقيعات والخطأ بيتسجّل. null = الملف نفسه مش موجود.
// mode: 'clear' = النسخة اللي بتروح جوجل/الـ DC (السطر المشطوب يوم فاضي) · 'strike' = معاينة/تحميل داخل التطبيق (السطر أحمر بسببه)
export async function signedFileBuffer(submissionId: bigint, mode: RejectMode = 'clear'): Promise<Buffer | null> {
  const sub = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      file: true,
      reviews: {
        orderBy: { createdAt: 'asc' },
        include: { byUser: { select: { email: true, displayName: true, title: true, accountSettings: { select: { signatureFile: true } } } } },
      },
      rowRejections: true,
      rowEdits: true,
    },
  });
  if (!sub) return null;
  const original = await storage.read(sub.file.filePath).catch(() => null);
  if (!original) return null;
  // السطور المشطوبة (النسخة الحالية) بتتطبق على الملف قبل الختم — نفس اللي بيشوفه المعتمدين وبيوصل جوجل
  // النسخة النهائية (تتختم وتروح جوجل/الـ DC): السطور المشطوبة بتبقى أيام فاضية — نضيفة بلا أثر أحمر (السبب في خانة سلسلة الاعتماد بالشيت)
  const buffer = await rejectedFileBuffer(original, sub.rowRejections, sub.revision, sub.kind as Kind, mode, sub.rowEdits);
  try {
    const sigs = await collectSignatures(sub.reviews, sub.revision);
    if (!sigs.length) return buffer;
    // (N11) مهلة للختم: ملف غريب بياخد وقت طويل مايعلّقش الطلب — بنرجع الأصل بلا توقيعات ونسجّل
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('انتهت مهلة ختم التوقيعات (20 ث)')), 20_000).unref?.());
    return await Promise.race([stampSignatures(buffer, sigs), timeout]);
  } catch (e) {
    console.error('[approval] فشل ختم التوقيعات — استُخدمت النسخة بلا توقيعات', submissionId.toString(), (e as Error).message);
    return buffer;
  }
}

// الملف بعد تطبيق تعديل/شطب السطور (النسخة الحالية فقط) — بيُستخدم أثناء المراجعة (للمعتمدين اللي بعده) وقبل الختم
// التعديلات (مدير المشروع) بتتطبق الأول ثم الشطب — سطر اتعدّل ثم اتشطب (حالة نادرة) يفضل شطب في النهاية.
type RowRejectionRow = { revision: number; sheetIndex: number; row: number; level: string; note: string | null };
type RowEditRow = { revision: number; sheetIndex: number; row: number; level: string; note: string; qtyTo: string | null; priceTo: string | null; notesTo: string | null; deductTo: string | null };
export async function rejectedFileBuffer(original: Buffer, rejections: RowRejectionRow[], revision: number, kind: Kind, mode: RejectMode = 'strike', edits: RowEditRow[] = []): Promise<Buffer> {
  const curRej = rejections.filter((r) => r.revision === revision);
  const curEdits = edits.filter((e) => e.revision === revision);
  if (!curRej.length && !curEdits.length) return original;
  let buffer = original;
  try {
    if (curEdits.length && kind !== 'equipment') {
      const asEdits: RowEdit[] = curEdits.map((e) => ({ sheetIndex: e.sheetIndex, row: e.row, level: e.level, note: e.note, qtyTo: e.qtyTo, priceTo: e.priceTo, notesTo: e.notesTo, deductTo: e.deductTo }));
      buffer = await applyRowEdits(buffer, asEdits, mode);
    }
  } catch (e) {
    console.error('[approval] فشل تطبيق تعديل السطور — استُخدم الأصل', (e as Error).message);
  }
  try {
    if (curRej.length) buffer = await applyRowRejections(buffer, curRej, kind === 'equipment' ? 'equipment' : 'labor', mode);
  } catch (e) {
    console.error('[approval] فشل تطبيق شطب السطور — استُخدم الأصل', (e as Error).message);
  }
  return buffer;
}

// توقيعات المستوى الواحد بتيجي من حساب المعتمد نفسه (نفس التوقيع اللي بيرفعه من شاشة "توقيع المهندس").
// بناخد آخر قرار اعتماد في النسخة الحالية لكل مستوى — الرفض مالوش توقيع طبعًا،
// والمستوى اللي معتمده مرفعش توقيع بيفضل بلوكه فاضي بالعنوان بس (زي ما كان بلوك العامل).
type SignatureReview = {
  level: string;
  decision: string;
  revision: number;
  createdAt?: Date;
  byUser: { email?: string; displayName?: string | null; title?: string | null; accountSettings: { signatureFile: { filePath: string; mimeType: string } | null } | null } | null;
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
    const by = r.byUser ? (r.byUser.displayName || r.byUser.title || (r.byUser.email ? r.byUser.email.split('@')[0] : '')) : '';
    const f = r.byUser?.accountSettings?.signatureFile;
    // معتمد بلا توقيع مرفوع: بنكتب "معتمد بواسطة" بس (البلوك فاضي) — image = null
    if (!f) { out.push({ level, image: null, ext: 'png', by: by || undefined, at: r.createdAt }); continue; }
    const image = await storage.read(f.filePath).catch(() => null);
    if (!image) { console.error('[approval] توقيع المعتمد مش موجود على السيرفر', level, f.filePath); out.push({ level, image: null, ext: 'png', by: by || undefined, at: r.createdAt }); continue; }
    out.push({ level, image, ext: f.mimeType.includes('jpeg') || f.mimeType.includes('jpg') ? 'jpeg' : 'png', by: by || undefined, at: r.createdAt });
  }
  return out;
}

// ملخص سلسلة الاعتماد (للنسخة الحالية) — بيتكتب في خانة "سلسلة الاعتماد" في جوجل شيت لما الكشف ينزل
// مثال: "team leader: ✅ معتمد (ahmed) 03/09 22:10 | project manager: 📝 بملاحظات: راجع الإجمالي (mostafa) 03/09 22:40"
type ReviewRow = { level: string; decision: string; note: string | null; revision: number; createdAt: Date; byUser: { email: string; displayName?: string | null; title: string | null } | null };
type RejectionRow = { revision: number; label: string; level: string; note: string | null };
type EditRow = { revision: number; label: string; level: string; note: string; qtyFrom: string | null; qtyTo: string | null; priceFrom: string | null; priceTo: string | null; totalFrom: string | null; totalTo: string | null; notesTo: string | null; deductTo: string | null };
export function approvalSummary(reviews: ReviewRow[], revision: number, rowRejections: RejectionRow[] = [], rowEdits: EditRow[] = []): string {
  const label: Record<string, string> = { APPROVED: '✅ معتمد', APPROVED_NOTES: '📝 بملاحظات', REJECTED: '❌ مرفوض' };
  const fmt = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const parts = reviews
    .filter((r) => r.revision === revision)
    .map((r) => {
      const who = r.byUser ? (r.byUser.displayName || r.byUser.title || r.byUser.email.split('@')[0]) : '';
      return `${r.level}: ${label[r.decision] ?? r.decision}${r.note ? ': ' + r.note : ''}${who ? ' (' + who + ')' : ''} ${fmt(r.createdAt)}`;
    });
  // السطور المشطوبة (رفض جزئي) — بتظهر في خانة سلسلة الاعتماد كمان عشان الـ DC يعرف إيه اللي اتشال
  const struck = rowRejections.filter((r) => r.revision === revision).map((r) => `❌ سطر مشطوب: ${r.label} — ${r.level}${r.note ? ': ' + r.note : ''}`);
  // السطور المعدّلة (مدير المشروع) — بتظهر في خانة سلسلة الاعتماد عشان الـ DC يعرف إيه اللي اتغيّر وليه
  const edited = rowEdits.filter((e) => e.revision === revision).map((e) => {
    const bits: string[] = [];
    if (e.qtyTo != null) bits.push(`العدد ${e.qtyFrom ?? '—'}→${e.qtyTo}`);
    if (e.priceTo != null) bits.push(`السعر ${e.priceFrom ?? '—'}→${e.priceTo}`);
    if (e.totalTo != null) bits.push(`الإجمالي ${e.totalFrom ?? '—'}→${e.totalTo}`);
    if (e.notesTo != null) bits.push('البيان اتعدّل');
    if (e.deductTo != null) bits.push('الخصم اتعدّل');
    return `✏️ سطر معدّل: ${e.label} — ${bits.join(' · ')} — ${e.level}: ${e.note}`;
  });
  if (!parts.length && !struck.length && !edited.length) return 'اتبعت مباشرة (مفيش معتمدين مضبوطين في التطبيق)';
  // كل اعتماد في سطر (الخانة في الشيت wrap) — أوضح من الفصل بـ |
  return (revision > 0 ? `نسخة ${revision}\n` : '') + [...parts, ...struck, ...edited].join('\n');
}

// بدء السلسلة لكشف جديد (أو إعادة إرسال): أول معتمد مسند لصاحب الكشف.
// لو مفيش أي معتمد مسند (أو درجته مش محتاجة اعتماد) → السلوك القديم: يتبعت لجوجل فورًا.
export async function startChain(submissionId: bigint): Promise<{ sentToSheet: boolean; firstLevel: string | null }> {
  const sub = await prisma.submission.findUnique({ where: { id: submissionId }, select: { userId: true, projectId: true } });
  if (!sub) return { sentToSheet: false, firstLevel: null };
  const chain = await resolveChainForUser(sub.userId, sub.projectId);
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
