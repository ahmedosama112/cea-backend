import { prisma } from '../config/prisma';

// ── ربط تسليمات الكشوف بجوجل شيت (Apps Script Web App) ──
// السكربت منشور كـ Web App بيشتغل بحساب الأدمن — السيرفر بيبعت له الملف + البيانات
// وهو بينفّذ نفس مسار الفورم القديم (حفظ في Drive → تحويل → صف في الشيت).
// الميزة معطّلة تلقائيًا لو المتغيرات مش موجودة (GOOGLE_WEBAPP_URL / GOOGLE_WEBAPP_SECRET).
//
// دعم مشاريع منفصلة (2026-08-26، واتوسّع لعدد مفتوح في 2026-09-22): كل مشروع له شيت
// وApps Script ومديرين مختلفين، وكل واحد بيتحط في متغيرات مستقلة:
//   المشروع 1 = GOOGLE_WEBAPP_URL / GOOGLE_WEBAPP_SECRET (أو _1)
//   المشروع n = GOOGLE_WEBAPP_URL_n / GOOGLE_WEBAPP_SECRET_n
// إضافة مشروع جديد = متغيرين جداد على السيرفر، من غير أي تعديل في الكود.
// لو متغيرات مشروع فاضية، تسليمات مهندسيه بتتحفظ محليًا عادي من غير دفع لجوجل (fail-safe).

interface SiteConfig { url: string; secret: string }
// رقم المشروع زي ما بيتخزن على التسليم — أي قيمة غلط أو ناقصة بترجع للمشروع 1 (السلوك القديم)
export function siteKey(site?: number | null): number {
  const n = Number(site);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}
function siteConfig(site?: number | null): SiteConfig {
  const k = siteKey(site);
  const suffix = k === 1 ? '' : '_' + k;
  return {
    url: process.env['GOOGLE_WEBAPP_URL' + suffix] || (k === 1 ? process.env.GOOGLE_WEBAPP_URL_1 || '' : ''),
    secret: process.env['GOOGLE_WEBAPP_SECRET' + suffix] || (k === 1 ? process.env.GOOGLE_WEBAPP_SECRET_1 || '' : ''),
  };
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
    console.error('Google WebApp call failed (site ' + siteKey(site) + '):', (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── طابور إرسال لكل مشروع ──
// الكشوف المتزامنة بتتبعت لجوجل واحد ورا التاني بدل ما تتزاحم على قفل الـ Apps Script
// (القفل هناك بيستنى 30 ثانية بس — لو 4-5 كشوف وصلوا في نفس اللحظة كان آخرهم بيفشل ويحتاج إعادة محاولة).
// فشل أي كشف في الطابور ما بيأثرش على اللي بعده.
// الطابور مستقل لكل مشروع (بيتعمل عند أول كشف) — مشاريع مختلفة بترفع في نفس الوقت،
// لأن كل شيت له Apps Script وقفل مستقل.
const pushChains = new Map<number, Promise<void>>();
function enqueuePush(site: number | null | undefined, task: () => Promise<void>): Promise<void> {
  const key = siteKey(site);
  const run = (pushChains.get(key) ?? Promise.resolve()).then(task, task);
  pushChains.set(key, run.catch(() => undefined));
  return run;
}

// إرسال كشف لجوجل (يشتغل في الخلفية بعد الرد على المهندس — التحويل هناك بياخد ثواني لدقيقة)
// عند النجاح: بنخزّن رقم الصف وid الملف على التسليم عشان متابعة الحالة لاحقًا
// approvalSummary: ملخص سلسلة اعتمادات المديرين داخل التطبيق — السكربت بيكتبه في خانة "سلسلة الاعتماد" (اختياري)
// ⚠ كل شيت لازم يكون عليه نسخة google-sheet/Code.gs الحالية. النسخ القديمة (زي Code-site2.gs
//   قبل 22 سبتمبر 2026) كانت بتترمي الـ approvalSummary ومفيهاش action=findRow، يعني ملاحظات
//   الاعتماد مش بتظهر في الشيت والكشف اللي رده ضاع مابيتلاقاش فيتعمل صف مكرر.
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

// دوّر على صف موجود بالفعل لنفس الكشف (اسم مهندس + اسم ملف) — يُستخدم قبل إعادة رفع بعد
// ما رد الرفع الأول ضاع (تايم آوت)، عشان "gsync" ما يعملش صف مكرر في الشيت
// notBefore: وقت إنشاء ملف الكشف الحالي — الصفوف الأقدم منه بتخص نسخة سابقة (إعادة إرسال
// كشف مرفوض بتعمل ملف جديد بنفس الاسم)، فربط الكشف بيها كان هيوصّل حالة النسخة الغلط
export async function findSheetRow(site: number | null | undefined, engineerName: string, fileName: string, notBefore?: Date | null): Promise<number | null> {
  if (!googleSyncEnabled(site)) return null;
  const result = await callWebApp(site, { action: 'findRow', engineerName, fileName, notBefore: notBefore ? notBefore.getTime() : undefined }, 30_000);
  if (result && result.ok) return Number(result.row) || null;
  console.error('Google findRow failed (site ' + siteKey(site) + '):', result?.error ?? '(no response)');
  return null;
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
  const key = siteKey(site) + ':' + [...rows].sort((a, b) => a - b).join(',');
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
    const k = siteKey(s.site);
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
