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

export function decodeBackupFile(json: string, entry: BackupFileEntry): Buffer {
  const object = JSON.parse(json);
  const data = Buffer.from(object.base64, 'base64');
  if (data.length !== entry.size || crypto.createHash('sha256').update(data).digest('hex') !== entry.sha256) {
    throw new Error(`Backup file integrity failure: ${entry.objectName}`);
  }
  return data;
}
