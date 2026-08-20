import { prisma } from '../config/prisma';
import { googleSyncEnabled } from './googleSheet';

// ── نسخة احتياطية كاملة لقاعدة البيانات → Google Drive (فولدر "CEA Backups") ──
// بتتبعت يوميًا عبر نفس Web App بتاع الشيت (action: backup). الملف JSON واحد فيه كل الجداول —
// كافي لإعادة بناء النظام بالكامل على أي سيرفر لو Railway ضاع نهائيًا.

const WEBAPP_URL = process.env.GOOGLE_WEBAPP_URL || '';
const WEBAPP_SECRET = process.env.GOOGLE_WEBAPP_SECRET || '';

export async function dumpDatabase(): Promise<Record<string, unknown>> {
  const [users, accountSettings, contractors, places, inspectors, items, itemStages, records, recordDeductions, irRecords, todos, execRecords, execRecordStages, dailyRecords, files, submissions] =
    await Promise.all([
      prisma.user.findMany(), // passwordHash ضمنها — مطلوب للاستعادة الكاملة، والملف في Drive الخاص بالأدمن
      prisma.accountSettings.findMany(),
      prisma.contractor.findMany(),
      prisma.place.findMany(),
      prisma.inspector.findMany(),
      prisma.item.findMany(),
      prisma.itemStage.findMany(),
      prisma.record.findMany(),
      prisma.recordDeduction.findMany(),
      prisma.irRecord.findMany(),
      prisma.todo.findMany(),
      prisma.execRecord.findMany(),
      prisma.execRecordStage.findMany(),
      prisma.dailyRecord.findMany(),
      prisma.file.findMany(),
      prisma.submission.findMany(),
    ]);
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    counts: { users: users.length, records: records.length, submissions: submissions.length },
    tables: { users, accountSettings, contractors, places, inspectors, items, itemStages, records, recordDeductions, irRecords, todos, execRecords, execRecordStages, dailyRecords, files, submissions },
  };
}

export async function runBackupToDrive(): Promise<{ ok: boolean; detail: string }> {
  if (!googleSyncEnabled()) return { ok: false, detail: 'ربط جوجل غير مفعّل (GOOGLE_WEBAPP_URL/SECRET)' };
  try {
    const dump = await dumpDatabase();
    const json = JSON.stringify(dump);
    const fileName = `cea-db-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const res = await fetch(WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: WEBAPP_SECRET, action: 'backup', fileName, fileBase64: Buffer.from(json, 'utf8').toString('base64') }),
      signal: controller.signal,
      redirect: 'follow',
    }).finally(() => clearTimeout(timer));
    const j = (await res.json().catch(() => null)) as { ok?: boolean; fileUrl?: string; error?: string } | null;
    if (j?.ok) {
      console.log(`[backup] ✅ ${fileName} → Drive (${Math.round(json.length / 1024)}KB)`);
      return { ok: true, detail: `${fileName} (${Math.round(json.length / 1024)}KB) → ${j.fileUrl ?? 'Drive'}` };
    }
    console.error('[backup] failed:', j?.error ?? res.status);
    return { ok: false, detail: j?.error ?? `HTTP ${res.status}` };
  } catch (e) {
    console.error('[backup] error:', (e as Error).message);
    return { ok: false, detail: (e as Error).message };
  }
}

// جدولة: فحص كل ساعة — أول فحص بعد الساعة 3 فجرًا UTC (٥-٦ صباحًا بتوقيت مصر) ينفّذ نسخة اليوم مرة واحدة
let lastBackupDate = '';
export function scheduleDailyBackup(): void {
  if (!googleSyncEnabled()) { console.log('[backup] معطّل — ربط جوجل غير مفعّل'); return; }
  const tick = async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getUTCHours() >= 3 && lastBackupDate !== today) {
      lastBackupDate = today; // نحجز اليوم قبل التنفيذ — عشان فشل مؤقت ما يسببش تكرار كل ساعة؛ بيتعاد المحاولة بكرة
      await runBackupToDrive();
    }
  };
  setInterval(tick, 60 * 60 * 1000);
  // نسخة عند الإقلاع لو لسه مفيش نسخة النهاردة (بعد دقيقة من التشغيل عشان الإقلاع يخلص)
  setTimeout(tick, 60 * 1000);
}
