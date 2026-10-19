// Read-only inventory. Never remove an orphan automatically: inspect all references and backups first.
import fs from 'fs/promises';
import path from 'path';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
async function main() {
  const rows = await prisma.file.findMany({ select: { filePath: true } });
  const references = new Set(rows.map(row => path.normalize(row.filePath)));
  const missing = new Set(references);
  const orphans: string[] = [];
  let fileCount = 0, bytes = 0, orphanBytes = 0;
  async function scan(relative: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(env.uploadDir, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await scan(child);
      else if (entry.isFile()) {
        const size = (await fs.stat(path.join(env.uploadDir, child))).size;
        fileCount++; bytes += size;
        missing.delete(child);
        if (!references.has(child)) { orphans.push(child); orphanBytes += size; }
      }
    }
  }
  await scan('');
  const disk = await fs.statfs(env.uploadDir);
  console.log(JSON.stringify({ at: new Date().toISOString(), fileCount, bytes, orphanBytes, orphans, missing: [...missing], volumeTotalBytes: disk.blocks * disk.bsize, volumeAvailableBytes: disk.bavail * disk.bsize, memory: process.memoryUsage() }, null, 2));
  if (missing.size) process.exitCode = 2;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
