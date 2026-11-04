import crypto from 'crypto';

export interface BackupFileEntry { filePath: string; sha256: string; size: number; objectName: string }

// One file at a time: do not retain all upload contents in the database snapshot.
// Objects are immutable and content-addressed; retain them while any database backup references them.
export async function backupFiles(
  rows: Array<{ filePath: string }>,
  write: (name: string, json: string) => Promise<void>,
  onMissing?: (filePath: string) => void,
): Promise<BackupFileEntry[]> {
  const { storage } = await import('./storage');
  const manifest: BackupFileEntry[] = [];
  for (const filePath of new Set(rows.map((row) => row.filePath))) {
    let data: Buffer;
    try { data = await storage.read(filePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && onMissing) { onMissing(filePath); continue; }
      throw error;
    }
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const objectName = `${sha256}.json`;
    await write(objectName, JSON.stringify({ version: 1, sha256, size: data.length, base64: data.toString('base64') }));
    manifest.push({ filePath, sha256, size: data.length, objectName });
  }
  return manifest;
}

// (نوفمبر 2026 — طلب صاحب المشروع) حسابات ملفاتها مش بتتنسخ: صاحب المشروع بطّل يكتب سراكي.
// صفوف الجداول بتاعتها بتفضل في النسخة؛ الملفات نفسها بس اللي بتتخطى وبتتسجل في skippedFiles.
const DEFAULT_SKIP_FILE_OWNERS = 'ahmed.osama.2016@gmail.com';

export function skipFileOwnerEmails(raw = process.env.BACKUP_SKIP_FILE_OWNERS ?? DEFAULT_SKIP_FILE_OWNERS): Set<string> {
  return new Set(raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
}

// يقسم صفوف الملفات: اللي هتتنسخ، ومسارات ملفات الحسابات المستثناة (مسار مشترك مع حساب تاني بيتنسخ عادي).
export function splitBackupFiles(
  users: Array<{ id: unknown; email: string }>,
  files: Array<{ filePath: string; userId: unknown }>,
  skipEmails: Set<string>,
): { backed: Array<{ filePath: string }>; skipped: string[] } {
  const skipIds = new Set(users.filter((u) => skipEmails.has(String(u.email).toLowerCase())).map((u) => String(u.id)));
  const backed = files.filter((f) => !skipIds.has(String(f.userId)));
  const backedPaths = new Set(backed.map((f) => f.filePath));
  const skipped = [...new Set(files.filter((f) => skipIds.has(String(f.userId))).map((f) => f.filePath))].filter((p) => !backedPaths.has(p));
  return { backed, skipped };
}

export function decodeBackupFile(json: string, entry: BackupFileEntry): Buffer {
  const object = JSON.parse(json);
  const data = Buffer.from(object.base64, 'base64');
  if (data.length !== entry.size || crypto.createHash('sha256').update(data).digest('hex') !== entry.sha256) {
    throw new Error(`Backup file integrity failure: ${entry.objectName}`);
  }
  return data;
}
