import { normName } from './analytics.service';
import { prisma } from '../config/prisma';
import { storage } from './storage';
import { pushSubmissionToGoogle } from './googleSheet';
import { stampSignatures, hasSignatureBox, LevelSignature } from './signStamp';
import { applyRowRejections, applyRowEdits, workbookLaborTotal, workbookLaborDaysDetail, Kind, RejectMode, RowEdit } from './rowReject';
import { saveLaborDays, isLaborSubmission, laborNameSet } from './laborContractors';

// ═══════════ سلسلة اعتمادات المديرين (داخل التطبيق قبل جوجل شيت) ═══════════
// الكشف بيعدّي على المعتمدين المسندين لصاحبه بالترتيب؛ وبس بعد ما يخلص كلهم بيتبعت لجوجل شيت.
//
// السلسلة مش عامة — بتتحدد لكل مهندس على حدة:
//   1) درجته (grade) بتحدد المستويات المطلوبة (المصفوفة تحت)
//   2) الأعمدة approver_tl_id / approver_cm_id / approver_pm_id بتحدد الشخص نفسه في كل مستوى
// مستوى من غير شخص مسند بيتخطى (والأدمن بيشوف تحذير في كارت الحساب).
//   3) (أكتوبر 2026) approver_sr_id: سينيور مسند للجونيور → خطوة زيادة في **أول** السلسلة قبل مدير الفريق.
//      السلسلة نفسها (المصفوفة وTL/CM/PM) مابتتغيرش؛ من غير سينيور مسند مفيش خطوة (السلوك القديم).

// الدرجات الخمس بالترتيب — ثابتة في الكود بقرار صاحب المشروع (بدل التعديل من app_config)
// 'viewer' مش رتبة في السلم — حساب بيشوف كل الكشوف وملفاتها بس مايعتمدش ولا يترفض أبدًا (مقصود آخر القائمة)
export const GRADES = ['junior', 'senior', 'team leader', 'construction manager', 'project manager', 'viewer'] as const;
export type Grade = (typeof GRADES)[number];

// الدرجات اللي بتعتمد (بترتيب السلسلة) — أعمدة جدول الاعتمادات في الواجهة هي دي. 'viewer' متعمّد مش موجود هنا.
export const APPROVING_GRADES = ['team leader', 'construction manager', 'project manager'] as const;

// (أكتوبر 2026) خطوة السينيور: برّه المصفوفة عن قصد (تعديل "مين يعتمد لمين" مايلمسهاش) —
// بتتحدد بالإسناد بس (approver_sr_id) ولدرجات SENIOR_STEP_FOR بس
export const SENIOR_LEVEL = 'senior';
const SENIOR_STEP_FOR = new Set(['junior']);
// كل المستويات اللي الكشف ممكن يقف عندها (بالترتيب) — أعمدة طابور الاعتمادات
export const CHAIN_LEVELS = [SENIOR_LEVEL, ...APPROVING_GRADES] as const;

// درجة بتعتمد لحد (بتشوف ملفات الكشوف ونطاق فريقها): الدرجات المعتمِدة + السينيور
export function isApproverGrade(grade: string | null | undefined): boolean {
  return !!grade && (CHAIN_LEVELS as readonly string[]).includes(grade);
}

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

// قائمة المستويات المعرّفة (بالترتيب) — أعمدة الجدول في تاب الاعتمادات (السينيور أولها)
export async function getApprovalLevels(): Promise<string[]> {
  return [...CHAIN_LEVELS];
}

// مدير المشروع واحد ثابت في المشروع — لو مفيش إسناد صريح وفيه حساب واحد بس بدرجة project manager
// بنستخدمه تلقائيًا. لو فيه أكتر من واحد، الإسناد الصريح بقى إلزامي (وإلا المستوى يتخطى).
async function soleProjectManagerId(): Promise<bigint | null> {
  const pms = await prisma.user.findMany({ where: { grade: 'project manager' }, select: { id: true }, take: 2 });
  return pms.length === 1 ? pms[0].id : null;
}

// خانة واحدة في السلسلة: المستوى + الشخص المسند له
export type ChainSlot = { level: string; approverId: bigint };
export type ChainUser = { id: bigint; grade: string; approverTlId: bigint | null; approverCmId: bigint | null; approverPmId: bigint | null; approverSrId?: bigint | null };

// بناء السلسلة من بيانات المستخدم (بلا استعلام) — عشان الطابور يحسب سلاسل كتير باستعلام واحد
export function buildChain(u: ChainUser, solePmId: bigint | null): ChainSlot[] {
  const slots: ChainSlot[] = [];
  // خطوة السينيور (لو مسند) قبل باقي السلسلة — مستقلة عن المصفوفة
  if (SENIOR_STEP_FOR.has(u.grade) && u.approverSrId && u.approverSrId !== u.id) slots.push({ level: SENIOR_LEVEL, approverId: u.approverSrId });
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
// مشروع عليه noApproval → السلسلة فاضية لأي حد (حتى من غير مدير المشروع الوحيد التلقائي).
export async function resolveChainForUser(userId: bigint, projectId?: number | null): Promise<ChainSlot[]> {
  if (projectId != null) {
    const p = await prisma.project.findUnique({ where: { id: projectId }, select: { noApproval: true } });
    if (p?.noApproval) return [];
  }
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, grade: true, approverTlId: true, approverCmId: true, approverPmId: true, approverSrId: true },
  });
  if (!u) return [];
  if (projectId != null) {
    const up = await prisma.userProject.findUnique({ where: { userId_projectId: { userId, projectId } } });
    if (up) {
      return buildChain(
        { id: u.id, grade: u.grade, approverTlId: up.approverTlId, approverCmId: up.approverCmId, approverPmId: up.approverPmId, approverSrId: up.approverSrId },
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
  if (!sub || sub.reviewState !== 'SENT') return;
  const toSend = await signedFileBuffer(submissionId, 'clear', sub.revision);
  if (!toSend) { console.error('[approval] ملف التسليم غير موجود عند الدفع لجوجل', submissionId.toString()); return; }
  // ده الرقم اللي وصل الشيت فعلًا بعد أي شطب — Submission.total بيفضل زي ما هو كسجل لما المهندس بعته.
  // بيتحفظ في كل دفعة (مش بس لما فيه شطب) عشان العمود يفضل دايمًا فيه اللي اتبعت فعلًا. فشل هنا ما بيوقفش الدفع.
  if (sub.kind === 'labor') {
    try {
      const real = await workbookLaborTotal(toSend);
      if (real != null) {
        const updated = await prisma.submission.updateMany({ where: { id: submissionId, revision: sub.revision, reviewState: 'SENT' }, data: { approvedTotal: real } });
        if (!updated.count) return;
      }
    } catch (e) {
      console.error('[approval] فشل حساب الإجمالي الفعلي', submissionId.toString(), (e as Error).message);
    }
    // أيام العمالة المعتمدة فعليًا لكل مقاول عمالة — لتقرير "مقاولين العمالة" (قبل/بعد الاعتماد). فشل هنا مايوقفش الدفع.
    try {
      const days = await workbookLaborDaysDetail(toSend);
      if (days) await saveLaborDays(submissionId, days, sub.revision);
    } catch (e) {
      console.error('[approval] فشل حساب أيام العمالة المعتمدة', submissionId.toString(), (e as Error).message);
    }
  }
  // نوع الكشف لجوجل: كشف مقاولين عمالة بياخد 'labor_contractor' (اسم الشيت المعتمد فيه "مقاول_عمالة") — فشل هنا يرجع 'labor'
  const googleKind = sub.kind === 'labor' && (await isLaborSubmission(sub.contractorName).catch(() => false)) ? 'labor_contractor' : sub.kind;
  // اسم المهندس في الشيت: الاسم بالعربي لو محدد، وإلا أول الإيميل (زي زمان)
  if (!await prisma.submission.findFirst({ where: { id: sub.id, revision: sub.revision, reviewState: 'SENT' }, select: { id: true } })) return;
  await pushSubmissionToGoogle(sub.id, toSend, sub.file.fileName, sub.user.displayName || sub.user.email.split('@')[0], sub.user.project ?? null, sub.site, approvalSummary(sub.reviews, sub.revision, sub.rowRejections, sub.rowEdits), googleKind, sub.revision);
}

// Prepare accounting outside the approval transaction; persist it with the real approval.
// Google latency/failure cannot leave a newly approved correction counted at its gross value.
export async function prepareApprovalAccounting(submissionId: bigint) {
  const sub = await prisma.submission.findUnique({ where: { id: submissionId }, include: { file: true, rowRejections: true, rowEdits: true } });
  if (!sub || sub.kind !== 'labor') return null;
  const original = await storage.read(sub.file.filePath).catch(() => null);
  if (!original) return null;
  const cleared = await rejectedFileBuffer(original, sub.rowRejections, sub.revision, 'labor', 'clear', sub.rowEdits);
  const total = await workbookLaborTotal(cleared);
  const days = await workbookLaborDaysDetail(cleared);
  if (total == null || !days) return null;
  const labor = await laborNameSet();
  return { total, days: [...days.entries()].filter(([name]) => labor.has(normName(name))).map(([name, detail]) => ({
    contractorName: name, days: detail.days, dates: Object.keys(detail.dates).length ? JSON.stringify(detail.dates) : null,
  })) };
}

// ملف الكشف **موقّعًا** بتوقيعات معتمدي النسخة الحالية — نفس النسخة اللي بتتبعت لجوجل.
// النسخة الموقّعة عابرة (بتتولّد عند الطلب من الأصل + سجل المراجعات) فما بتتخزنش، وده بيخلي
// المعاينة/التحميل بعد الاعتماد الكامل مطابقين دايمًا للي وصل الشيت.
// فشل الختم مايوقفش حاجة — بيرجع الأصل بلا توقيعات والخطأ بيتسجّل. null = الملف نفسه مش موجود.
// mode: 'clear' = النسخة اللي بتروح جوجل/الـ DC (السطر المشطوب يوم فاضي) · 'strike' = معاينة/تحميل داخل التطبيق (السطر أحمر بسببه)
// revision: نسخة قديمة اتبدّلت بإعادة إرسال (ملفها من submission_revisions) — الافتراضي النسخة الحالية
export async function signedFileBuffer(submissionId: bigint, mode: RejectMode = 'clear', revision?: number): Promise<Buffer | null> {
  const sub = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      file: true,
      // صاحب الكشف: لو مدير مشروع بيتختم توقيعه في بلوك مدير المشروع (collectSignatures)
      user: { select: { grade: true, email: true, displayName: true, title: true, accountSettings: { select: { signatureFile: true } } } },
      reviews: {
        orderBy: { createdAt: 'asc' },
        include: { byUser: { select: { email: true, displayName: true, title: true, accountSettings: { select: { signatureFile: true } } } } },
      },
      rowRejections: true,
      rowEdits: true,
    },
  });
  if (!sub) return null;
  const rev = revision ?? sub.revision;
  let filePath = sub.file.filePath;
  if (rev !== sub.revision) {
    const old = await prisma.submissionRevision.findUnique({ where: { submissionId_revision: { submissionId, revision: rev } }, include: { file: true } });
    if (!old?.file) return null;
    filePath = old.file.filePath;
  }
  const original = await storage.read(filePath).catch(() => null);
  if (!original) return null;
  // السطور المشطوبة (النسخة الحالية) بتتطبق على الملف قبل الختم — نفس اللي بيشوفه المعتمدين وبيوصل جوجل
  // النسخة النهائية (تتختم وتروح جوجل/الـ DC): السطور المشطوبة بتبقى أيام فاضية — نضيفة بلا أثر أحمر (السبب في خانة سلسلة الاعتماد بالشيت)
  const buffer = await rejectedFileBuffer(original, sub.rowRejections, rev, sub.kind as Kind, mode, sub.rowEdits);
  try {
    const sigs = await collectSignatures(sub.reviews, rev, sub.user);
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
type SignerUser = { email?: string; displayName?: string | null; title?: string | null; accountSettings: { signatureFile: { filePath: string; mimeType: string } | null } | null } | null;
type SignatureReview = {
  level: string;
  decision: string;
  revision: number;
  createdAt?: Date;
  byUser: SignerUser;
};
// صاحب الكشف — بيتختم توقيعه في بلوك درجته لو درجته من SELF_SIGN_GRADES
export type SignatureSubmitter = NonNullable<SignerUser> & { grade: string };

// (أكتوبر 2026) مدير المشروع لما يبعت سركيه بنفسه: سلسلته فاضية (مفيش مراجعة) فبلوك "توقيع مدير المشروع" تحت
// كان بيطلع فاضي، رغم إن توقيعه بيتحط جمب السطور من الواجهة. دلوقتي توقيعه من حسابه بيتختم في البلوك ده كمان —
// إلا لو فيه مدير مشروع اعتمد الكشف فعلًا في النسخة الحالية (توقيع المعتمد هو اللي يتحط).
const SELF_SIGN_GRADES = new Set(['project manager']);

async function signatureOf(level: string, u: SignerUser, at?: Date): Promise<LevelSignature> {
  const by = (u ? (u.displayName || u.title || (u.email ? u.email.split('@')[0] : '')) : '') || undefined;
  const f = u?.accountSettings?.signatureFile;
  // بلا توقيع مرفوع: بنكتب "معتمد بواسطة" بس (البلوك فاضي) — image = null
  if (!f) return { level, image: null, ext: 'png', by, at };
  const image = await storage.read(f.filePath).catch(() => null);
  if (!image) { console.error('[approval] توقيع المعتمد مش موجود على السيرفر', level, f.filePath); return { level, image: null, ext: 'png', by, at }; }
  return { level, image, ext: f.mimeType.includes('jpeg') || f.mimeType.includes('jpg') ? 'jpeg' : 'png', by, at };
}

export async function collectSignatures(reviews: SignatureReview[], revision: number, submitter?: SignatureSubmitter | null): Promise<LevelSignature[]> {
  const byLevel = new Map<string, SignatureReview>();
  for (const r of reviews) {
    if (r.revision !== revision) continue;
    if (r.decision !== 'APPROVED' && r.decision !== 'APPROVED_NOTES') continue;
    if (!hasSignatureBox(r.level)) continue;
    byLevel.set(r.level, r); // آخر اعتماد على المستوى ده هو المعتمد
  }
  const out: LevelSignature[] = [];
  for (const [level, r] of byLevel) out.push(await signatureOf(level, r.byUser, r.createdAt));
  if (submitter && SELF_SIGN_GRADES.has(submitter.grade) && hasSignatureBox(submitter.grade) && !byLevel.has(submitter.grade)) {
    out.push(await signatureOf(submitter.grade, submitter));
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
    void pushSubmissionToSheet(submissionId).catch(() => console.error('[approval] Google sync failed; approval remains recorded'));
    return { sentToSheet: true, firstLevel: null };
  }
  await prisma.submission.update({
    where: { id: submissionId },
    data: { reviewState: 'IN_REVIEW', currentLevel: first.level, currentApproverId: first.approverId },
  });
  return { sentToSheet: false, firstLevel: first.level };
}
