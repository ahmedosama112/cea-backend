/* eslint-disable no-console */
// (2026-09-19) استرجاع أيام العمالة المعتمدة (SubmissionLaborDays) لكشوف العمالة القديمة اللي اتبعتت
// قبل إضافة الميزة دي — من غيره تقرير "مقاولين العمالة" بيعتبرها "غير محسوبة" (estimated).
// بيقرا الملف الموقّع النهائي (زي اللي وصل جوجل شيت بالظبط) ويحسب الأيام منه. Idempotent —
// saveLaborDays بيمسح صفوف الكشف القديمة قبل ما يكتب الجديدة، فتشغيله أكتر من مرة آمن.
//
//   npx ts-node --transpile-only scripts/backfill-labor-days.ts
import { PrismaClient } from '@prisma/client';
import { signedFileBuffer } from '../src/services/approvalChain';
import { workbookLaborDaysByContractor } from '../src/services/rowReject';
import { saveLaborDays } from '../src/services/laborContractors';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const subs = await prisma.submission.findMany({
    where: { kind: 'labor', reviewState: 'SENT' },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  console.log(`كشوف عمالة مُرسَلة (SENT): ${subs.length}`);

  let ok = 0;
  let noFile = 0;
  let noDays = 0;
  let failed = 0;

  for (const s of subs) {
    try {
      const buffer = await signedFileBuffer(s.id, 'clear');
      if (!buffer) { noFile++; continue; }
      const days = await workbookLaborDaysByContractor(buffer);
      if (!days) { failed++; continue; }
      if (!days.size) { noDays++; continue; }
      await saveLaborDays(s.id, days);
      ok++;
    } catch (e) {
      failed++;
      console.error(`  ❌ كشف ${s.id.toString()}:`, (e as Error).message);
    }
  }

  console.log(`✅ اترجعت: ${ok} | بلا ملف: ${noFile} | بلا مقاول عمالة: ${noDays} | فشل: ${failed}`);
}

main()
  .catch((e) => { console.error('⛔ فشل السكربت:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
