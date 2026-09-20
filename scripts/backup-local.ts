/* eslint-disable no-console */
// نسخة احتياطية محلية — بتسحب قاعدة الإنتاج على جهازك في فولدر backups/
//
// ليه: النسخة اليومية بتروح Drive على حساب جوجل. لو الحساب ده راح (اختراق/قفل/حذف)،
// النسخ بتروح معاه. دي النسخة التالتة — على جهازك، مش معتمدة على أي حساب سحابي.
//
// التشغيل:
//   npm run backup:local
//
// بيحتاج PROD_DATABASE_URL في ملف .env (رابط قاعدة الإنتاج من Railway).
// الملف الناتج بنفس صيغة الباك اب اليومي بالظبط — يعني scripts/restore-backup.ts
// بيقراه زي ما هو (وده المسار اللي اتجرّب واتأكد في 20 سبتمبر 2026).
//
// ⚠ الملف فيه هاشات كلمات السر — فولدر backups/ لازم يفضل خارج git (وهو كذلك).

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const PROD_URL = process.env.PROD_DATABASE_URL || '';
const OUT_DIR = path.resolve(__dirname, '..', '..', 'backups');

async function main(): Promise<void> {
  if (!PROD_URL) {
    console.error('⛔ PROD_DATABASE_URL مش موجود في .env');
    console.error('   هاته من Railway: قاعدة MySQL → Variables → MYSQL_PUBLIC_URL (الرابط العام مش الداخلي)');
    process.exit(1);
  }
  // --local: تصريح صريح بسحب قاعدة محلية (تجربة/لقطة تطوير). الملف بياخد لاحقة -dev
  // عشان لقطة تطوير ما تتلبّسش كأنها نسخة إنتاج في نفس الفولدر.
  const allowLocal = process.argv.includes('--local');
  const isLocal = /localhost|127\.0\.0\.1/.test(PROD_URL);
  if (isLocal && !allowLocal) {
    console.error('⛔ PROD_DATABASE_URL بيشاور على قاعدة محلية — ده مش الإنتاج. راجع .env');
    console.error('   (لو قصدك فعلًا تاخد لقطة من قاعدة محلية: زوّد --local)');
    process.exit(1);
  }
  if (isLocal) console.warn('⚠ لقطة من قاعدة محلية — دي مش نسخة إنتاج.');

  // لازم يتظبط قبل ما config/prisma يتحمّل (بيقرا DATABASE_URL وقت إنشاء العميل)
  process.env.DATABASE_URL = PROD_URL;
  const { dumpDatabase, missingBackupModels } = await import('../src/services/backup');
  const { prisma } = await import('../src/config/prisma');

  const host = PROD_URL.replace(/\/\/[^@]*@/, '//***@');
  console.log(`📡 بسحب من: ${host}`);

  // نفس الحارس بتاع الباك اب اليومي — جدول جديد في الschema ومش متغطّى = نسخة ناقصة
  const missing = missingBackupModels();
  if (missing.length) {
    console.error(`⛔ جداول في الschema مش متغطّاة في BACKUP_TABLES: ${missing.join(', ')}`);
    console.error('   النسخة هتطلع ناقصة — ضيفهم في src/services/backup.ts الأول.');
    await prisma.$disconnect();
    process.exit(1);
  }

  const dump = (await dumpDatabase()) as { counts: Record<string, number>; tables: Record<string, unknown[]> };
  const json = JSON.stringify(dump);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `cea-db-backup-${new Date().toISOString().slice(0, 10)}${isLocal ? '-dev' : ''}.json`);
  fs.writeFileSync(file, json, 'utf8');

  const size = `${Math.round(json.length / 1024)}KB`;
  console.log(`\n✅ اتحفظت: ${file} (${size})`);
  console.log(`   الجداول: ${Object.keys(dump.tables).length} · مستخدمين: ${dump.counts.users} · سراكي: ${dump.counts.records} · كشوف: ${dump.counts.submissions}`);

  // تحذير لو النسخة مريبة (قاعدة فاضية أو سحب ناقص)
  if (!dump.counts.users) console.warn('⚠ صفر مستخدمين — النسخة دي مريبة، راجع الرابط قبل ما تعتمد عليها');

  // آخر النسخ الموجودة — عشان تشوف بعينك إن فيه تتابع
  const all = fs.readdirSync(OUT_DIR).filter((f) => /^cea-db-backup-.*\.json$/.test(f)).sort().reverse();
  console.log('\n📂 آخر النسخ المحلية:');
  for (const f of all.slice(0, 5)) {
    const st = fs.statSync(path.join(OUT_DIR, f));
    console.log(`   ${f}  ${Math.round(st.size / 1024)}KB`);
  }
  if (all.length > 8) console.log(`   (+${all.length - 8} أقدم — امسح القديم لما يزيد)`);

  console.log('\n↩ للاستعادة من الملف ده:');
  console.log(`   npx ts-node --transpile-only scripts/restore-backup.ts "${file}" --wipe`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error('⛔ فشل:', e); process.exit(1); });
