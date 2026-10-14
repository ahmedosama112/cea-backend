// Run on the application host, with its DATABASE_URL and UPLOAD_DIR.
// Copy the resulting directory off-host; a second directory on the same volume is not disaster recovery.
import fs from 'fs/promises';
import path from 'path';
import { dumpDatabase, missingBackupModels } from '../src/services/backup';
import { backupFiles } from '../src/services/backupFiles';
import { prisma } from '../src/config/prisma';
async function main() {
  const destination = process.argv[2];
  if (!destination) throw new Error('Usage: npm run backup:complete -- <new destination directory>');
  if (missingBackupModels().length) throw new Error('Incomplete database backup table coverage');
  const target = path.resolve(destination);
  await fs.mkdir(target, { mode: 0o700 }); // Refuse to overwrite an existing backup.
  await fs.mkdir(path.join(target, 'files'), { mode: 0o700 });
  const dump = await dumpDatabase();
  dump.fileManifest = await backupFiles((dump.tables as { files: Array<{ filePath: string }> }).files, async (name, json) => {
    await fs.writeFile(path.join(target, 'files', name), json, { mode: 0o600 });
  });
  dump.version = 2;
  await fs.writeFile(path.join(target, 'database.json'), JSON.stringify(dump), { mode: 0o600 });
  console.log('Complete backup written; copy the entire directory to independent storage.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
