import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { googleSyncEnabled } from './googleSheet';
import { backupFiles } from './backupFiles';

// ── نسخة احتياطية كاملة لقاعدة البيانات → Google Drive (فولدر "CEA Backups") ──
// بتتبعت يوميًا عبر نفس Web App بتاع الشيت (action: backup). الملف JSON واحد فيه كل الجداول —
// يعيد قاعدة البيانات؛ محتويات uploads تحتاج نسخة ملفات مستقلة.

const WEBAPP_URL = process.env.GOOGLE_WEBAPP_URL || process.env.GOOGLE_WEBAPP_URL_1 || '';
const WEBAPP_SECRET = process.env.GOOGLE_WEBAPP_SECRET || process.env.GOOGLE_WEBAPP_SECRET_1 || '';

// جداول مستثناة **عمدًا** من النسخة (مالهاش قيمة بعد الاستعادة):
// الجلسات وتوكنات إعادة التعيين بتنتهي بطبيعتها، وسجل النشاط بيتمسح بعد 14 يوم أصلًا.
const BACKUP_SKIP = new Set(['RefreshToken', 'PasswordResetToken', 'ActivityLog']);

// كل جدول في القاعدة لازم يكون هنا أو في BACKUP_SKIP — والحارس (missingBackupModels) بيمسك
// أي جدول جديد اتضاف للـschema ونُسي هنا. الترتيب بيحترم الـFK (الآباء قبل الأبناء) عشان
// scripts/restore-backup.ts يقدر يمشي عليه كما هو.
// ⚠ (8 سبتمبر 2026) equipmentRecords وsubmissionReviews وsubmissionRowRejections كانوا ناقصين
// من النسخة شهور — والاستعادة كانت بتقول "اكتملت" وهي مضيّعاهم.
const BACKUP_TABLES: Array<{ key: string; model: string; rows: () => Prisma.PrismaPromise<unknown[]> }> = [
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
  // طلبات الإيجار قبل records — Record.rentRequestId بتشاور عليها
  { key: 'rentRequests', model: 'RentRequest', rows: () => prisma.rentRequest.findMany() },
  { key: 'rentRequestReviews', model: 'RentRequestReview', rows: () => prisma.rentRequestReview.findMany() },
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
  { key: 'submissionRowEdits', model: 'SubmissionRowEdit', rows: () => prisma.submissionRowEdit.findMany() },
  { key: 'submissionComments', model: 'SubmissionComment', rows: () => prisma.submissionComment.findMany() },
  { key: 'submissionLaborDays', model: 'SubmissionLaborDays', rows: () => prisma.submissionLaborDays.findMany() },
  { key: 'submissionRevisions', model: 'SubmissionRevision', rows: () => prisma.submissionRevision.findMany() },
  { key: 'appConfig', model: 'AppConfig', rows: () => prisma.appConfig.findMany() },
  { key: 'inventoryItems', model: 'InventoryItem', rows: () => prisma.inventoryItem.findMany() },
  { key: 'issueRequests', model: 'IssueRequest', rows: () => prisma.issueRequest.findMany() },
  { key: 'issueRequestLines', model: 'IssueRequestLine', rows: () => prisma.issueRequestLine.findMany() },
  { key: 'stockMoves', model: 'StockMove', rows: () => prisma.stockMove.findMany() },
  { key: 'purchaseRequests', model: 'PurchaseRequest', rows: () => prisma.purchaseRequest.findMany() },
  { key: 'notifications', model: 'Notification', rows: () => prisma.notification.findMany() },
  { key: 'notificationTargets', model: 'NotificationTarget', rows: () => prisma.notificationTarget.findMany() },
  { key: 'notificationReads', model: 'NotificationRead', rows: () => prisma.notificationRead.findMany() },
];

// أسماء الجداول بترتيب الإدراج — يستوردها سكربت الاستعادة عشان القايمتين ما يفترقوش تاني
export const BACKUP_ORDER: string[] = BACKUP_TABLES.map((t) => t.key);

// جداول موجودة في الـschema ومش متغطية لا بالنسخة ولا بالاستثناء = ثغرة في الباك اب
export function missingBackupModels(): string[] {
  const covered = new Set<string>([...BACKUP_TABLES.map((t) => t.model), ...BACKUP_SKIP]);
  return Prisma.dmmf.datamodel.models.map((m) => m.name).filter((n) => !covered.has(n));
}

export async function dumpDatabase(): Promise<Record<string, unknown>> {
  const results = await prisma.$transaction(BACKUP_TABLES.map((t) => t.rows()), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
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

type UploadKind =
  | 'success'
  | 'http-json-error'
  | 'http-non-json-before-content'
  | 'content-redirect-failed'
  | 'http-5xx'
  | 'network'
  | 'abort'
  | 'unexpected-redirect';

type BackupResult = { ok: boolean; detail: string };
type UploadResult = BackupResult & { kind: UploadKind; retryable: boolean };
type RunSource = 'manual' | 'scheduled' | 'retry';

const MAX_STATUS_JSON_LENGTH = 900;
const MAX_STATUS_DETAIL_CODE_POINTS = 700;
const RETRY_DELAYS_MS = new Map([[2, 15 * 60 * 1000], [3, 60 * 60 * 1000]]);

function normalizeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function safeDetail(value: string): string {
  let detail = normalizeText(value).replace(/https?:\/\/\S+/giu, '[url]');
  if (WEBAPP_SECRET) detail = detail.split(WEBAPP_SECRET).join('[redacted]');
  return detail;
}

function responseSnippet(value: string): string {
  return safeDetail(value)
    .replace(/(["']?secret["']?\s*[:=]\s*)["']?[^,"'\s}]+/giu, '$1[redacted]')
    .slice(0, 200);
}

// (M7) آخر نتيجة نسخ احتياطي بتتسجل في app_config — JSON صالح دائمًا وفي حدود العمود.
async function recordBackupStatus(ok: boolean, rawDetail: string): Promise<void> {
  try {
    const detailCodePoints = Array.from(safeDetail(rawDetail)).slice(0, MAX_STATUS_DETAIL_CODE_POINTS);
    const payload = { at: new Date().toISOString(), ok, detail: detailCodePoints.join('') };
    let value = JSON.stringify(payload);
    while (value.length > MAX_STATUS_JSON_LENGTH && detailCodePoints.length) {
      detailCodePoints.pop();
      payload.detail = detailCodePoints.join('');
      value = JSON.stringify(payload);
    }
    await prisma.appConfig.upsert({ where: { key: 'lastBackupStatus' }, update: { value }, create: { key: 'lastBackupStatus', value } });
    if (ok) await prisma.appConfig.upsert({ where: { key: 'lastBackupSuccess' }, update: { value: payload.at }, create: { key: 'lastBackupSuccess', value: payload.at } });
  } catch { /* تسجيل الحالة best-effort */ }
}

function parseJson(text: string): { ok?: boolean; fileUrl?: string; error?: string } | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === 'object'
      ? parsed as { ok?: boolean; fileUrl?: string; error?: string }
      : null;
  } catch {
    return null;
  }
}

async function uploadBackup(json: string, fileName: string, action: 'backup' | 'backup-file' = 'backup'): Promise<UploadResult> {
  const body = JSON.stringify({ secret: WEBAPP_SECRET, action, fileName, fileBase64: Buffer.from(json, 'utf8').toString('base64') });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const startedAt = Date.now();
  const hops: Array<{ status: number; contentType: string; hostname: string; durationMs: number }> = [];
  let finalText = '';

  const observe = (kind: UploadKind): void => {
    const observation = {
      kind,
      totalDurationMs: Date.now() - startedAt,
      jsonBytes: Buffer.byteLength(json, 'utf8'),
      requestBytes: Buffer.byteLength(body, 'utf8'),
      hops,
      responseSnippet: responseSnippet(finalText),
    };
    const line = JSON.stringify(observation);
    if (kind === 'success') console.log(`[backup] upload ${line}`);
    else console.error(`[backup] upload ${line}`);
  };

  try {
    const firstStartedAt = Date.now();
    let response = await fetch(WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
      redirect: 'manual',
    });
    let hostname = '';
    try { hostname = new URL(response.url || WEBAPP_URL).hostname; } catch { hostname = 'invalid'; }
    hops.push({
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      hostname,
      durationMs: Date.now() - firstStartedAt,
    });

    let followedContentRedirect = false;
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      let redirectUrl: URL | null = null;
      try {
        redirectUrl = location ? new URL(location) : null;
      } catch {
        try { redirectUrl = location && WEBAPP_URL ? new URL(location, WEBAPP_URL) : null; } catch { redirectUrl = null; }
      }
      if ((response.status !== 302 && response.status !== 303) || redirectUrl?.hostname !== 'script.googleusercontent.com') {
        observe('unexpected-redirect');
        return { ok: false, detail: `تحويل غير متوقع إلى ${redirectUrl?.hostname ?? 'عنوان غير صالح'}`, kind: 'unexpected-redirect', retryable: false };
      }
      followedContentRedirect = true;
      const redirectStartedAt = Date.now();
      response = await fetch(redirectUrl.toString(), { method: 'GET', signal: controller.signal, redirect: 'manual' });
      hops.push({
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        hostname: redirectUrl.hostname,
        durationMs: Date.now() - redirectStartedAt,
      });
      // (أكتوبر 2026) خادم المحتوى نفسه (جوجل) بيرجّع تحويل تاني بشكل متقطع — نفس فئة الـ 404/HTML العابرة،
      // والمحاولة اللي بعدها بتنجح. كان بيوقف محاولات اليوم كله؛ دلوقتي بيعيد زي باقي أعطال خادم المحتوى.
      // (التحويل الأول لهوست غير جوجل فوق بيفضل يوقف على طول)
      if (response.status >= 300 && response.status < 400) {
        observe('content-redirect-failed');
        return { ok: false, detail: 'تحويل إضافي غير متوقع من خادم المحتوى', kind: 'content-redirect-failed', retryable: true };
      }
    }

    finalText = await response.text();
    const result = parseJson(finalText);
    if (result?.ok === true && response.ok) {
      observe('success');
      return { ok: true, detail: 'Drive', kind: 'success', retryable: false };
    }
    if (result?.ok === false) {
      const detail = safeDetail(String(result.error ?? `HTTP ${response.status}`));
      observe('http-json-error');
      return { ok: false, detail, kind: 'http-json-error', retryable: false };
    }
    if (followedContentRedirect) {
      observe('content-redirect-failed');
      return { ok: false, detail: `فشل تأكيد نتيجة الرفع من خادم المحتوى (HTTP ${response.status})`, kind: 'content-redirect-failed', retryable: true };
    }
    if (response.status >= 500) {
      observe('http-5xx');
      return { ok: false, detail: `خطأ مؤقت من خدمة النسخ (HTTP ${response.status})`, kind: 'http-5xx', retryable: true };
    }
    observe('http-non-json-before-content');
    return { ok: false, detail: `استجابة غير صالحة قبل الوصول لخادم المحتوى (HTTP ${response.status})`, kind: 'http-non-json-before-content', retryable: true };
  } catch (error) {
    const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
    const kind: UploadKind = aborted ? 'abort' : 'network';
    const detail = aborted ? 'انتهت مهلة الاتصال بخدمة النسخ' : safeDetail(error instanceof Error ? error.message : 'خطأ شبكة غير معروف');
    observe(kind);
    return { ok: false, detail, kind, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

async function performBackupAttempt(): Promise<UploadResult> {
  if (!googleSyncEnabled()) {
    return { ok: false, detail: 'ربط جوجل غير مفعّل (GOOGLE_WEBAPP_URL/SECRET)', kind: 'http-json-error', retryable: false };
  }
  try {
    const missingModels = missingBackupModels();
    if (missingModels.length) throw new Error(`Incomplete backup table coverage: ${missingModels.join(', ')}`);
    const dump = await dumpDatabase();
    const missingFiles: string[] = [];
    dump.fileManifest = await backupFiles((dump.tables as { files: Array<{ filePath: string }> }).files, async (name, contents) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const uploaded = await uploadBackup(contents, name, 'backup-file');
        if (uploaded.ok) return;
        if (!uploaded.retryable || attempt === 2) throw new Error(`File backup failed: ${uploaded.detail}`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }, filePath => missingFiles.push(filePath));
    dump.missingFiles = missingFiles;
    dump.fileBackupStatus = missingFiles.length ? 'partial' : 'complete';
    dump.version = 2;
    const json = JSON.stringify(dump);
    const fileName = `cea-db-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const result = await uploadBackup(json, fileName);
    if (!result.ok) {
      await recordBackupStatus(false, result.detail);
      return result;
    }

    const saved = JSON.stringify({ at: new Date().toISOString(), files: (dump.fileManifest as unknown[]).length, missing: missingFiles.length, complete: missingFiles.length === 0 });
    await prisma.appConfig.upsert({ where: { key: 'lastBackupSaved' }, update: { value: saved }, create: { key: 'lastBackupSaved', value: saved } });
    if (missingFiles.length) {
      const detail = `تم حفظ قاعدة البيانات و${(dump.fileManifest as unknown[]).length} ملفًا — النسخة غير مكتملة: ${missingFiles.length} ملفات مفقودة من التخزين، موثقة في missingFiles`;
      await recordBackupStatus(false, detail);
      return { ok: false, detail, kind: 'http-json-error', retryable: false };
    }
    const size = `${Math.round(Buffer.byteLength(json, 'utf8') / 1024)}KB`;
    const missing = missingBackupModels();
    if (missing.length) {
      const detail = `${fileName} (${size}) — ⚠ ناقصة جداول: ${missing.join(', ')}`;
      console.error('[backup] ⚠ نسخة ناقصة — جداول غير مغطّاة:', missing.join(', '));
      await recordBackupStatus(false, detail);
      return { ok: false, detail, kind: 'http-json-error', retryable: false };
    }
    const detail = `${fileName} (${size})`;
    console.log(`[backup] ✅ ${detail} → Drive`);
    await recordBackupStatus(true, detail);
    return { ok: true, detail: `${detail} → Drive`, kind: 'success', retryable: false };
  } catch (error) {
    const detail = safeDetail(error instanceof Error ? error.message : 'خطأ غير معروف أثناء تجهيز النسخة');
    console.error('[backup] prepare error:', detail);
    await recordBackupStatus(false, detail);
    return { ok: false, detail, kind: 'network', retryable: true };
  }
}

type DailyRetryState = {
  date: string;
  attempts: number;
  initialAt: number;
  halted: boolean;
  timers: Map<number, NodeJS.Timeout>;
};

let lastBackupDate = '';
let dailyRetryState: DailyRetryState | null = null;
let inFlight: Promise<UploadResult> | null = null;
let retryAttempt: () => Promise<UploadResult> = performBackupAttempt;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function clearRetryTimers(state: DailyRetryState): void {
  for (const timer of state.timers.values()) clearTimeout(timer);
  state.timers.clear();
}

function stateForToday(): DailyRetryState {
  const date = todayUtc();
  if (!dailyRetryState || dailyRetryState.date !== date) {
    if (dailyRetryState) clearRetryTimers(dailyRetryState);
    dailyRetryState = { date, attempts: 0, initialAt: Date.now(), halted: false, timers: new Map() };
  }
  return dailyRetryState;
}

function scheduleRetries(state: DailyRetryState): void {
  for (const [attempt, delay] of RETRY_DELAYS_MS) {
    if (attempt <= state.attempts || state.timers.has(attempt)) continue;
    const remaining = Math.max(0, state.initialAt + delay - Date.now());
    const timer = setTimeout(() => {
      state.timers.delete(attempt);
      if (state.date === todayUtc() && lastBackupDate !== state.date && !state.halted && state.attempts < attempt) {
        void runCoordinatedBackup('retry', retryAttempt);
      }
    }, remaining);
    state.timers.set(attempt, timer);
  }
}

function nextRetryMessage(state: DailyRetryState): string {
  const nextAttempt = [...state.timers.keys()].sort((a, b) => a - b)[0];
  if (!nextAttempt) return '';
  const target = state.initialAt + (RETRY_DELAYS_MS.get(nextAttempt) ?? 0);
  const minutes = Math.max(1, Math.round((target - Date.now()) / 60_000));
  return ` — هيتعاد تلقائيًا (محاولة ${nextAttempt} من 3 بعد ~${minutes} دقيقة)`;
}

async function runCoordinatedBackup(source: RunSource, attempt: () => Promise<UploadResult>): Promise<BackupResult> {
  const existing = inFlight;
  if (existing) {
    const result = await existing;
    const state = stateForToday();
    return { ok: result.ok, detail: result.detail + (source === 'manual' && result.retryable ? nextRetryMessage(state) : '') };
  }

  const state = stateForToday();
  const outsideQuotaManualAttempt = source === 'manual'
    && (lastBackupDate === state.date || state.halted || state.attempts >= 3);
  if (!outsideQuotaManualAttempt) {
    if (state.halted || state.attempts >= 3) return { ok: false, detail: 'اكتملت محاولات النسخ الثلاث لهذا اليوم' };
    if (state.attempts === 0) retryAttempt = attempt;
    state.attempts += 1;
    const plannedTimer = state.timers.get(state.attempts);
    if (plannedTimer) clearTimeout(plannedTimer);
    state.timers.delete(state.attempts);
  }

  const attemptPromise = (async () => {
    const result = await attempt();
    if (result.ok) {
      lastBackupDate = state.date;
      clearRetryTimers(state);
    } else if (!outsideQuotaManualAttempt) {
      if (result.retryable && state.attempts < 3) scheduleRetries(state);
      else if (!result.retryable) {
        state.halted = true;
        clearRetryTimers(state);
      }
    }
    return result;
  })();
  inFlight = attemptPromise;
  const result = await attemptPromise.finally(() => {
    if (inFlight === attemptPromise) inFlight = null;
  });

  const retryMessage = source === 'manual' && result.retryable && !outsideQuotaManualAttempt
    ? nextRetryMessage(state)
    : '';
  return { ok: result.ok, detail: result.detail + retryMessage };
}

export async function runBackupToDrive(source: RunSource = 'manual'): Promise<BackupResult> {
  return runCoordinatedBackup(source, performBackupAttempt);
}

// واجهة ضيقة لاختبارات الانحدار فقط؛ لا تدخل في مسار التشغيل الفعلي.
export const __backupTest = {
  uploadBackup,
  recordBackupStatus,
  runCoordinatedBackup,
  resetCoordinator(): void {
    if (dailyRetryState) clearRetryTimers(dailyRetryState);
    dailyRetryState = null;
    inFlight = null;
    lastBackupDate = '';
    retryAttempt = performBackupAttempt;
  },
  coordinatorState(): { attempts: number; successfulDate: string; retryTimers: number } {
    return {
      attempts: dailyRetryState?.attempts ?? 0,
      successfulDate: lastBackupDate,
      retryTimers: dailyRetryState?.timers.size ?? 0,
    };
  },
};

// جدولة: فحص كل ساعة — النجاح وحده هو اللي يقفل اليوم، والفشل المؤقت بيتعاد بعد 15 و60 دقيقة.
export function scheduleDailyBackup(): void {
  if (!googleSyncEnabled()) { console.log('[backup] معطّل — ربط جوجل غير مفعّل'); return; }
  const tick = async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    try {
      if (lastBackupDate !== today) {
        const saved = await prisma.appConfig.findUnique({ where: { key: 'lastBackupSuccess' } });
        if (saved?.value.slice(0, 10) === today) lastBackupDate = today;
      }
      if (now.getUTCHours() >= 3 && lastBackupDate !== today) await runBackupToDrive('scheduled');
    } catch { console.error('[backup] scheduled backup check failed'); }
  };
  setInterval(tick, 60 * 60 * 1000);
  // نسخة عند الإقلاع لو لسه مفيش نسخة النهاردة (بعد دقيقة من التشغيل عشان الإقلاع يخلص)
  setTimeout(tick, 60 * 1000);
}
