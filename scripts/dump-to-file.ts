/* eslint-disable no-console */
// توليد ملف باك اب محلي بنفس صيغة الباك اب اليومي بالظبط (للاختبار أو النسخ اليدوي بدون Drive)
// التشغيل: npx ts-node --transpile-only scripts/dump-to-file.ts [مسار الحفظ]
import * as fs from 'fs';
import { dumpDatabase } from '../src/services/backup';

dumpDatabase()
  .then((d) => {
    const out = process.argv[2] || `cea-db-backup-${new Date().toISOString().slice(0, 10)}.json`;
    fs.writeFileSync(out, JSON.stringify(d));
    console.log(`✅ ${out} (${Math.round(fs.statSync(out).size / 1024)}KB)`);
    process.exit(0);
  })
  .catch((e) => { console.error(e); process.exit(1); });
