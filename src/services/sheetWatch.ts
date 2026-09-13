import { prisma } from '../config/prisma';
import { googleSyncEnabled, fetchStatusesBySite } from './googleSheet';

// ── مراقبة ملاحظة الـDC في الخلفية (عمود E في جوجل شيت) ──
// المشكلة: الملاحظة كانت بتتقرا live بس لما المهندس يفتح "تسليماتي" ويضغط تحديث — لو ما فتحش
// الشاشة، أهم رسالة بتوصله (رفض/ملاحظة من DC) ممكن تضيع. الجوب ده بيقرا دوريًا ويخزّن التغيير
// كعلامة "لسه ما اتشافتش" حتى لو المهندس ما فتحش حاجة.

async function tick(): Promise<void> {
  if (!googleSyncEnabled()) return;
  // الجوب بيتكلم مع جوجل، فلازم يفضل محدود مهما كبر الجدول — آخر 45 يوم و100 كشف بالكتير
  const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  const candidates = await prisma.submission.findMany({
    where: {
      reviewState: 'SENT',
      createdAt: { gte: since },
      // الجوب عمره ما بيكتب gsheetRow: ربط الصف يدوي بقرار صاحب المشروع (زرار "تحديث لتلقي ملاحظات DC")
      // — كاتب تلقائي ممكن يربط كشف بصف غلط والمهندس يشوف حالة حد تاني
      gsheetRow: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      site: true,
      gsheetRow: true,
      dcNote: true,
      file: { select: { fileName: true, createdAt: true } },
      user: { select: { email: true, displayName: true } },
    },
  });
  if (!candidates.length) return;

  const statuses = await fetchStatusesBySite(candidates as Array<{ gsheetRow: number | null; site: number }>);
  let changed = 0;
  for (const sub of candidates) {
    if (!sub.gsheetRow) continue; // للـTypeScript بس — الفلتر فوق ضامن ده
    const st = statuses[sub.site + ':' + sub.gsheetRow];
    if (!st) continue;
    const note = String(st.execNotes || '').trim() || null;
    if (note === (sub.dcNote || null)) continue; // مفيش تغيير — من غير UPDATE لغاية ما نلاقي فرق فعلي
    await prisma.submission.update({
      where: { id: sub.id },
      data: { dcNote: note, dcNoteAt: note ? new Date() : null, dcNoteSeenAt: null },
    });
    changed++;
  }
  if (changed) console.log(`[sheetWatch] ملاحظات اتحدّثت: ${changed}`);
}

// كل 10 دقايق، وأول تشغيل بعد دقيقتين من الإقلاع (نفس شكل scheduleDailyBackup)
export function scheduleSheetWatch(): void {
  if (!googleSyncEnabled()) { console.log('[sheetWatch] معطّل — ربط جوجل غير مفعّل'); return; }
  const run = () => { tick().catch((e) => console.error('[sheetWatch] error:', (e as Error).message)); };
  setInterval(run, 10 * 60 * 1000);
  setTimeout(run, 2 * 60 * 1000);
}
