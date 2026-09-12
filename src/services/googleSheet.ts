import { prisma } from '../config/prisma';

// ── ربط تسليمات الكشوف بجوجل شيت (Apps Script Web App) ──
// السكربت منشور كـ Web App بيشتغل بحساب الأدمن — السيرفر بيبعت له الملف + البيانات
// وهو بينفّذ نفس مسار الفورم القديم (حفظ في Drive → تحويل → صف في الشيت).
// الميزة معطّلة تلقائيًا لو المتغيرات مش موجودة (GOOGLE_WEBAPP_URL / GOOGLE_WEBAPP_SECRET).
//
// دعم مشروعين منفصلين (2026-08-26): كل موقع (site 1 أو 2) له شيت وApps Script ومديرين مختلفين.
// الموقع 1 = المتغيرات الأصلية، الموقع 2 = GOOGLE_WEBAPP_URL_2 / GOOGLE_WEBAPP_SECRET_2.
// لو متغيرات الموقع 2 فاضية، تسليمات مهندسيه بتتحفظ محليًا عادي من غير دفع لجوجل (fail-safe).

interface SiteConfig { url: string; secret: string }
const SITES: Record<number, SiteConfig> = {
  1: { url: process.env.GOOGLE_WEBAPP_URL || '', secret: process.env.GOOGLE_WEBAPP_SECRET || '' },
  2: { url: process.env.GOOGLE_WEBAPP_URL_2 || '', secret: process.env.GOOGLE_WEBAPP_SECRET_2 || '' },
};
function siteConfig(site?: number | null): SiteConfig {
  return SITES[site === 2 ? 2 : 1];
}

export function googleSyncEnabled(site?: number | null): boolean {
  const c = siteConfig(site);
  return Boolean(c.url && c.secret);
}

async function callWebApp(site: number | null | undefined, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const c = siteConfig(site);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(c.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: c.secret, ...payload }),
      signal: controller.signal,
      redirect: 'follow', // Apps Script بيرد بـ redirect لرابط النتيجة — لازم نتبعه
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch (e) {
    console.error('Google WebApp call failed (site ' + (site === 2 ? 2 : 1) + '):', (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── طابور إرسال لكل موقع ──
// الكشوف المتزامنة بتتبعت لجوجل واحد ورا التاني بدل ما تتزاحم على قفل الـ Apps Script
// (القفل هناك بيستنى 30 ثانية بس — لو 4-5 كشوف وصلوا في نفس اللحظة كان آخرهم بيفشل ويحتاج إعادة محاولة).
// فشل أي كشف في الطابور ما بيأثرش على اللي بعده.
const pushChains: Record<number, Promise<void>> = { 1: Promise.resolve(), 2: Promise.resolve() };
function enqueuePush(site: number | null | undefined, task: () => Promise<void>): Promise<void> {
  const key = site === 2 ? 2 : 1;
  const run = pushChains[key].then(task, task);
  pushChains[key] = run.catch(() => undefined);
  return run;
}

// إرسال كشف لجوجل (يشتغل في الخلفية بعد الرد على المهندس — التحويل هناك بياخد ثواني لدقيقة)
// عند النجاح: بنخزّن رقم الصف وid الملف على التسليم عشان متابعة الحالة لاحقًا
// approvalSummary: ملخص سلسلة اعتمادات المديرين داخل التطبيق — السكربت بيكتبه في خانة "سلسلة الاعتماد" (اختياري)
// ⚠ الموقع 2: Code-site2.gs لسه النسخة القديمة — doPost بينده processNewSubmission بـ 3 باراميترات،
//   فالـ approvalSummary بيتبعت من هنا وبيتترمي هناك (الملاحظات مش بتظهر في الشيت، التوقيعات بتنزل عادي).
//   اتأجل بقرار صاحب المشروع (8 سبتمبر 2026) لأن الموقع 2 لسه مشتغلش — يتظبط قبل ما يشتغل.
export function pushSubmissionToGoogle(submissionId: bigint, fileBuffer: Buffer, fileName: string, engineerName: string, project: string | null, site: number | null | undefined, approvalSummary?: string): Promise<void> {
  return enqueuePush(site, () => doPushSubmission(submissionId, fileBuffer, fileName, engineerName, project, site, approvalSummary));
}

async function doPushSubmission(submissionId: bigint, fileBuffer: Buffer, fileName: string, engineerName: string, project: string | null, site: number | null | undefined, approvalSummary?: string): Promise<void> {
  if (!googleSyncEnabled(site)) return;
  // (7 سبتمبر 2026) حماية من التكرار: الدفع بيتنفذ من طابور — لو كشف اتبعت مرتين (اعتماد + "إعادة الإرسال للشيت" وقت ما الأول لسه شغال)
  // التاني بيلاقي الصف اتسجل خلاص فبيتخطى بدل ما يعمل صف مكرر في الشيت
  const already = await prisma.submission.findUnique({ where: { id: submissionId }, select: { gsheetRow: true } }).catch(() => null);
  if (already?.gsheetRow) return;
  const result = await callWebApp(
    site,
    {
      engineerName,
      project: project || '',
      fileName,
      fileBase64: fileBuffer.toString('base64'),
      approvalSummary: approvalSummary || '',
    },
    300_000, // (8 سبتمبر 2026) كان 120 ث: كشف بـ 12 ورقة بياخد أكتر في التحويل + PDF — لو قطعنا الاتصال بدري السكربت بيكمل ويعمل الصف بس إحنا مانعرفش رقمه (خطر تكرار عند إعادة الإرسال). حد Apps Script نفسه 6 دقايق
  );
  if (result && result.ok) {
    await prisma.submission
      .update({
        where: { id: submissionId },
        data: {
          gsheetRow: Number(result.row) || null,
          gdriveFileId: (result.fileId as string) || null,
        },
      })
      .catch(() => undefined);
  } else {
    console.error('Google sync failed for submission', submissionId.toString(), result?.error ?? '(no response)');
  }
}

// جلب حالات صفوف من الشيت (لعرض "وصل لفين" للمهندس) — استدعاء واحد لكل مجموعة صفوف
export interface SheetRowStatus {
  status: string;
  execApproval: string;
  pmApproval: string;
  execNotes: string;
  pmNotes: string;
}
// (M6) كاش قصير لحالات الشيت — عشان انقطاع/بطء جوجل ما يعلّقش شاشة الاعتمادات لكل مهندس،
// والمهلة 4 ثواني بدل 15: الحالة بيانات عرض مش حرجة، وأحدث نسخة هتوصل في التحديث الجاي
const statusCache = new Map<string, { at: number; data: Record<number, SheetRowStatus> }>();
const STATUS_CACHE_MS = 60_000;

export async function fetchSheetStatuses(rows: number[], site: number | null | undefined): Promise<Record<number, SheetRowStatus>> {
  if (!googleSyncEnabled(site) || !rows.length) return {};
  const key = (site === 2 ? 2 : 1) + ':' + [...rows].sort((a, b) => a - b).join(',');
  const cached = statusCache.get(key);
  if (cached && Date.now() - cached.at < STATUS_CACHE_MS) return cached.data;
  // (12 سبتمبر 2026) المهلة كانت 4 ث — مع 45+ كشف في الشاشة النداء كان بيتقطع دايمًا
  // ("This operation was aborted" في اللوجات) فكل الكروت تبقى بلا بيانات شيت: مفيش اعتماد DC
  // ولا ملاحظته. الحل الأساسي في Code.gs (قراءة رينج واحد بدل خانة بخانة)، ودي مهلة أوسع تحسبًا
  // لبطء جوجل نفسه. لسه مش حرجة: الفشل بيرجّع آخر نسخة معروفة من الكاش.
  const result = await callWebApp(site, { action: 'status', rows }, 12_000);
  if (result && result.ok && result.statuses) {
    const data = result.statuses as Record<number, SheetRowStatus>;
    statusCache.set(key, { at: Date.now(), data });
    if (statusCache.size > 500) statusCache.clear();
    return data;
  }
  // فشل مؤقت: نرجّع آخر نسخة معروفة لو موجودة (حتى لو قديمة) بدل ما الحالة تختفي
  return cached?.data ?? {};
}

// جلب الحالات لتسليمات ممكن تكون من الموقعين — بيجمع الصفوف حسب الموقع وينده كل Web App مرة واحدة.
// الإرجاع مفتاحه "site:row" عشان أرقام الصفوف ممكن تتكرر بين الشيتين.
export async function fetchStatusesBySite(subs: Array<{ gsheetRow: number | null; site: number }>): Promise<Record<string, SheetRowStatus>> {
  const bySite = new Map<number, number[]>();
  for (const s of subs) {
    if (!s.gsheetRow) continue;
    const k = s.site === 2 ? 2 : 1;
    if (!bySite.has(k)) bySite.set(k, []);
    bySite.get(k)!.push(s.gsheetRow);
  }
  const out: Record<string, SheetRowStatus> = {};
  await Promise.all(
    [...bySite.entries()].map(async ([site, rows]) => {
      const statuses = await fetchSheetStatuses(rows, site);
      for (const [row, st] of Object.entries(statuses)) out[site + ':' + row] = st;
    }),
  );
  return out;
}
