import { prisma } from '../config/prisma';

// ── ربط تسليمات الكشوف بجوجل شيت (Apps Script Web App) ──
// السكربت منشور كـ Web App بيشتغل بحساب الأدمن — السيرفر بيبعت له الملف + البيانات
// وهو بينفّذ نفس مسار الفورم القديم (حفظ في Drive → تحويل → صف في الشيت).
// الميزة معطّلة تلقائيًا لو المتغيرات مش موجودة (GOOGLE_WEBAPP_URL / GOOGLE_WEBAPP_SECRET).

const WEBAPP_URL = process.env.GOOGLE_WEBAPP_URL || '';
const WEBAPP_SECRET = process.env.GOOGLE_WEBAPP_SECRET || '';

export function googleSyncEnabled(): boolean {
  return Boolean(WEBAPP_URL && WEBAPP_SECRET);
}

async function callWebApp(payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: WEBAPP_SECRET, ...payload }),
      signal: controller.signal,
      redirect: 'follow', // Apps Script بيرد بـ redirect لرابط النتيجة — لازم نتبعه
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch (e) {
    console.error('Google WebApp call failed:', (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// إرسال كشف لجوجل (يشتغل في الخلفية بعد الرد على المهندس — التحويل هناك بياخد ثواني لدقيقة)
// عند النجاح: بنخزّن رقم الصف وid الملف على التسليم عشان متابعة الحالة لاحقًا
export async function pushSubmissionToGoogle(submissionId: bigint, fileBuffer: Buffer, fileName: string, engineerName: string, project: string | null): Promise<void> {
  if (!googleSyncEnabled()) return;
  const result = await callWebApp(
    {
      engineerName,
      project: project || '',
      fileName,
      fileBase64: fileBuffer.toString('base64'),
    },
    120_000, // التحويل + تجهيز التوقيعات في السكربت ممكن ياخد دقيقة+
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
export async function fetchSheetStatuses(rows: number[]): Promise<Record<number, SheetRowStatus>> {
  if (!googleSyncEnabled() || !rows.length) return {};
  const result = await callWebApp({ action: 'status', rows }, 15_000);
  if (result && result.ok && result.statuses) return result.statuses as Record<number, SheetRowStatus>;
  return {};
}
