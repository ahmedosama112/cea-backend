/* eslint-disable no-console */
// إزالة السجلات المكررة لمستخدم (نفس التاريخ/المقاول/الكمية/السعر/الخصم/الإجمالي/المكان/الملاحظات)
// يحتفظ بأقدم نسخة (أصغر id) ويحذف الباقي.
//
//   npx ts-node --transpile-only scripts/dedupe-records.ts <email>            → تقرير فقط (dry run)
//   npx ts-node --transpile-only scripts/dedupe-records.ts <email> --apply    → حذف فعلي
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const [email, ...flags] = process.argv.slice(2);
  if (!email) { console.error('الاستخدام: dedupe-records.ts <email> [--apply]'); process.exit(1); }
  const apply = flags.includes('--apply');

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) throw new Error('المستخدم غير موجود');

  const rows = await prisma.record.findMany({
    where: { userId: user.id },
    include: { deductions: { select: { name: true } } },
    orderBy: { id: 'asc' },
  });

  const sig = (r: (typeof rows)[number]) =>
    [r.date.toISOString().slice(0, 10), r.contractorName, r.placeName, String(r.qty), r.qtyType, String(r.price), String(r.discount), String(r.total), r.notes ?? '', r.deductNote ?? '', r.deductions.map((d) => d.name).sort().join(',')].join('|');

  const seen = new Map<string, bigint>();
  const toDelete: bigint[] = [];
  for (const r of rows) {
    const s = sig(r);
    if (seen.has(s)) toDelete.push(r.id);
    else seen.set(s, r.id);
  }

  const totalBefore = rows.reduce((a, r) => a + Number(r.total), 0);
  const keptTotal = rows.filter((r) => !toDelete.includes(r.id)).reduce((a, r) => a + Number(r.total), 0);

  console.log(`المستخدم: ${email}`);
  console.log(`إجمالي السجلات: ${rows.length} | فريدة: ${seen.size} | مكررة للحذف: ${toDelete.length}`);
  console.log(`مجموع المبالغ قبل: ${totalBefore} | بعد: ${keptTotal}`);

  if (!apply) { console.log('\n(تقرير فقط — أضف --apply للحذف الفعلي)'); return; }
  if (!toDelete.length) { console.log('لا يوجد مكرر.'); return; }

  const BATCH = 100;
  for (let i = 0; i < toDelete.length; i += BATCH) {
    await prisma.record.deleteMany({ where: { id: { in: toDelete.slice(i, i + BATCH) }, userId: user.id } });
  }
  const after = await prisma.record.count({ where: { userId: user.id } });
  console.log(`✅ تم الحذف — المتبقي: ${after}`);
}

main().catch((e) => { console.error('❌', e.message ?? e); process.exit(1); }).finally(() => prisma.$disconnect());
