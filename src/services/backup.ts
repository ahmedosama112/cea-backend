import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { googleSyncEnabled } from './googleSheet';

// ── نسخة احتياطية كاملة لقاعدة البيانات → Google Drive (فولدر "CEA Backups") ──
// بتتبعت يوميًا عبر نفس Web App بتاع الشيت (action: backup). الملف JSON واحد فيه كل الجداول —
// كافي لإعادة بناء النظام بالكامل على أي سيرفر لو Railway ضاع نهائيًا.

const WEBAPP_URL = process.env.GOOGLE_WEBAPP_URL || '';
const WEBAPP_SECRET = process.env.GOOGLE_WEBAPP_SECRET || '';

// جداول مستثناة **عمدًا** من النسخة (مالهاش قيمة بعد الاستعادة):
// الجلسات وتوكنات إعادة التعيين بتنتهي بطبيعتها، وسجل النشاط بيتمسح بعد 14 يوم أصلًا.
const BACKUP_SKIP = new Set(['RefreshToken', 'PasswordResetToken', 'ActivityLog']);

// كل جدول في القاعدة لازم يكون هنا أو في BACKUP_SKIP — والحارس (missingBackupModels) بيمسك
// أي جدول جديد اتضاف للـschema ونُسي هنا. الترتيب بيحترم الـFK (الآباء قبل الأبناء) عشان
// scripts/restore-backup.ts يقدر يمشي عليه كما هو.
// ⚠ (8 سبتمبر 2026) equipmentRecords وsubmissionReviews وsubmissionRowRejections كانوا ناقصين
// من النسخة شهور — والاستعادة كانت بتقول "اكتملت" وهي مضيّعاهم.
const BACKUP_TABLES: Array<{ key: string; model: string; rows: () => Promise<unknown[]> }> = [
  // passwordHash ضمن users — مطلوب للاستعادة الكاملة، والملف في Drive الخاص بالأدمن
  { key: 'users', model: 'User', rows: () => prisma.user.findMany() },
  { key: 'files', model: 'File', rows: () => prisma.file.findMany() },
  { key: 'accountSettings', model: 'AccountSettings', rows: () => prisma.accountSettings.findMany() },
  // (16 سبتمبر 2026) المشاريع + المشاريع المحمّلة على الحسابات بمعتمديها — بعد users عشان المفاتيح الأجنبية
  { key: 'projects', model: 'Project', rows: () => prisma.project.findMany() },
  { key: 'userProjects', model: 'UserProject', rows: () => prisma.userProject.findMany() },
  { key: 'contractors', model: 'Contractor', rows: () => prisma.contractor.findMany() },
  { key: 'places', model: 'Place', rows: () => prisma.place.findMany() },
  { key: 'inspectors', model: 'Inspector', rows: () => prisma.inspector.findMany() },
  { key: 'items', model: 'Item', rows: () => prisma.item.findMany() },
  { key: 'itemStages', model: 'ItemStage', rows: () => prisma.itemStage.findMany() },
  { key: 'records', model: 'Record', rows: () => prisma.record.findMany() },
  { key: 'recordDeductions', model: 'RecordDeduction', rows: () => prisma.recordDeduction.findMany() },
  { key: 'irRecords', model: 'IrRecord', rows: () => prisma.irRecord.findMany() },
  { key: 'todos', model: 'Todo', rows: () => prisma.todo.findMany() },
  { key: 'execRecords', model: 'ExecRecord', rows: () => prisma.execRecord.findMany() },
  { key: 'execRecordStages', model: 'ExecRecordStage', rows: () => prisma.execRecordStage.findMany() },
  { key: 'dailyRecords', model: 'DailyRecord', rows: () => prisma.dailyRecord.findMany() },
  { key: 'equipmentRecords', model: 'EquipmentRecord', rows: () => prisma.equipmentRecord.findMany() },
  { key: 'submissions', model: 'Submission', rows: () => prisma.submission.findMany() },
  { key: 'submissionReviews', model: 'SubmissionReview', rows: () => prisma.submissionReview.findMany() },
  { key: 'submissionRowRejections', model: 'SubmissionRowRejection', rows: () => prisma.submissionRowRejection.findMany() },
  { key: 'appConfig', model: 'AppConfig', rows: () => prisma.appConfig.findMany() },
  { key: 'inventoryItems', model: 'InventoryItem', rows: () => prisma.inventoryItem.findMany() },
  { key: 'issueRequests', model: 'IssueRequest', rows: () => prisma.issueRequest.findMany() },
  { key: 'issueRequestLines', model: 'IssueRequestLine', rows: () => prisma.issueRequestLine.findMany() },
  { key: 'stockMoves', model: 'StockMove', rows: () => prisma.stockMove.findMany() },
  { key: 'purchaseRequests', model: 'PurchaseRequest', rows: () => prisma.purchaseRequest.findMany() },
  { key: 'notifications', model: 'Notification', rows: () => prisma.notification.findMany() },
  { key: 'notificationTargets', model: 'NotificationTarget', rows: () => prisma.notificationTarget.findMany() },
  { key: 'notificationReads', model: 'NotificationRead', rows: () => prisma.notificationRead.findMany() },
  { key: 'rentRequests', model: 'RentRequest', rows: () => prisma.rentRequest.findMany() },
  { key: 'rentRequestReviews', model: 'RentRequestReview', rows: () => prisma.rentRequestReview.findMany() },
];

// أسماء الجداول بترتيب الإدراج — يستوردها سكربت الاستعادة عشان القايمتين ما يفترقوش تاني
export const BACKUP_ORDER: string[] = BACKUP_TABLES.map((t) => t.key);

// جداول موجودة في الـschema ومش متغطية لا بالنسخة ولا بالاستثناء = ثغرة في الباك اب
export function missingBackupModels(): string[] {
  const covered = new Set<string>([...BACKUP_TABLES.map((t) => t.model), ...BACKUP_SKIP]);
  return Prisma.dmmf.datamodel.models.map((m) => m.name).filter((n) => !covered.has(n));
}

export async function dumpDatabase(): Promise<Record<string, unknown>> {
  const results = await Promise.all(BACKUP_TABLES.map((t) => t.rows()));
  const tables: Record<string, unknown[]> = {};
  BACKUP_TABLES.forEach((t, i) => { tables[t.key] = results[i]; });
  const count = (k: string) => (tables[k] ? tables[k].length : 0);
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    counts: {
      users: count('users'),
      records: count('records'),
      submissions: count('submissions'),
      equipmentRecords: count('equipmentRecords'),
      submissionReviews: count('submissionReviews'),
      tables: BACKUP_TABLES.length,
    },
    tables,
  };
}

// (M7) آخر نتيجة نسخ احتياطي بتتسجل في app_config — الفشل مبقاش صامتًا، والأدمن يقدر يستعلم عنها
async function recordBackupStatus(ok: boolean, detail: string): Promise<void> {
  try {
    const value = JSON.stringify({ at: new Date().toISOString(), ok, detail }).slice(0, 190);
    await prisma.appConfig.upsert({ where: { key: 'lastBackupStatus' }, update: { value }, create: { key: 'lastBackupStatus', value } });
  } catch { /* تسجيل الحالة best-effort */ }
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
      const size = `${Math.round(json.length / 1024)}KB`;
      // النسخة اترفعت — بس لو فيه جدول في الـschema مش متغطّى، دي نسخة **ناقصة**:
      // تتسجّل فاشلة عشان الأدمن يشوفها في الكارت وفي التنبيهات بدل ما يكتشفها يوم الاستعادة.
      const missing = missingBackupModels();
      if (missing.length) {
        const detail = `${fileName} (${size}) — ⚠ ناقصة جداول: ${missing.join(', ')}`;
        console.error('[backup] ⚠ نسخة ناقصة — جداول غير مغطّاة:', missing.join(', '));
        await recordBackupStatus(false, detail);
        return { ok: false, detail };
      }
      console.log(`[backup] ✅ ${fileName} → Drive (${size})`);
      await recordBackupStatus(true, `${fileName} (${size})`);
      return { ok: true, detail: `${fileName} (${size}) → ${j.fileUrl ?? 'Drive'}` };
    }
    console.error('[backup] failed:', j?.error ?? res.status);
    await recordBackupStatus(false, String(j?.error ?? `HTTP ${res.status}`));
    return { ok: false, detail: j?.error ?? `HTTP ${res.status}` };
  } catch (e) {
    console.error('[backup] error:', (e as Error).message);
    await recordBackupStatus(false, (e as Error).message);
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
