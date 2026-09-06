import fs from 'fs';
import { app } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { scheduleDailyBackup } from './services/backup';
import { scheduleTokenCleanup } from './services/auth.service';
import { scheduleActivityCleanup } from './services/activityLog';
import { loadApprovalMatrix } from './services/approvalChain';

fs.mkdirSync(env.uploadDir, { recursive: true });

const server = app.listen(env.port, () => {
  console.log(`CEA API listening on port ${env.port} [${env.nodeEnv}]`);
});

// نسخة احتياطية يومية لقاعدة البيانات → Google Drive (لو الربط مفعّل)
if (env.nodeEnv === 'production') scheduleDailyBackup();
// (L5) تنظيف يومي للتوكنات المنتهية/الملغية — بدونه جداول التوكنات تنمو للأبد
if (env.nodeEnv !== 'test') scheduleTokenCleanup();
if (env.nodeEnv !== 'test') scheduleActivityCleanup();
// مصفوفة "مين يعتمد لمين" بتتحمّل من app_config مرة عند الإقلاع (وبتتحدث بعد أي حفظ)
void loadApprovalMatrix();

async function shutdown(signal: string) {
  console.log(`${signal} received — shutting down gracefully`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
