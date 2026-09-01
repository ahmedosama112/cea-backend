/* eslint-disable no-console */
// جرد افتتاحي افتراضي لوحدة المخازن — مواد بناء شائعة بأكواد ووحدات مقترحة (كلها كمية صفر).
// آمن للتكرار: بيتخطى أي كود موجود بالفعل، ولا يلمس الكميات إطلاقًا.
// التشغيل: npx ts-node --transpile-only scripts/seed-inventory.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ITEMS: Array<{ code: string; name: string; unit: string }> = [
  { code: 'CEM-01', name: 'أسمنت بورتلاندي عادي', unit: 'شيكارة' },
  { code: 'CEM-02', name: 'أسمنت مقاوم للكبريتات', unit: 'شيكارة' },
  { code: 'STL-08', name: 'حديد تسليح 8 مم', unit: 'طن' },
  { code: 'STL-10', name: 'حديد تسليح 10 مم', unit: 'طن' },
  { code: 'STL-12', name: 'حديد تسليح 12 مم', unit: 'طن' },
  { code: 'STL-16', name: 'حديد تسليح 16 مم', unit: 'طن' },
  { code: 'SND-01', name: 'رمل مونة', unit: 'م3' },
  { code: 'GRV-01', name: 'زلط (سن 1)', unit: 'م3' },
  { code: 'GRV-02', name: 'زلط (سن 2)', unit: 'م3' },
  { code: 'BRK-01', name: 'طوب أحمر 25×12×6', unit: 'عدد' },
  { code: 'BRK-02', name: 'طوب طفلي مصمت', unit: 'عدد' },
  { code: 'BLK-01', name: 'بلوك أسمنتي 40×20×20', unit: 'عدد' },
  { code: 'GYP-01', name: 'جبس مؤسس', unit: 'شيكارة' },
  { code: 'PUT-01', name: 'معجون حوائط', unit: 'عبوة' },
  { code: 'PNT-01', name: 'دهان بلاستيك أبيض', unit: 'عبوة' },
  { code: 'PNT-02', name: 'برايمر أساس', unit: 'عبوة' },
  { code: 'CER-01', name: 'سيراميك أرضيات', unit: 'م2' },
  { code: 'CER-02', name: 'سيراميك حوائط', unit: 'م2' },
  { code: 'INT-01', name: 'إنترلوك رصف', unit: 'م2' },
  { code: 'PIP-01', name: 'مواسير PVC 4 بوصة', unit: 'متر' },
  { code: 'PIP-02', name: 'مواسير PPR 3/4 بوصة', unit: 'متر' },
  { code: 'ELC-01', name: 'سلك كهرباء 2 مم', unit: 'لفة' },
  { code: 'ELC-02', name: 'سلك كهرباء 3 مم', unit: 'لفة' },
  { code: 'WPF-01', name: 'رولات عزل بيتوميني', unit: 'لفة' },
  { code: 'ADD-01', name: 'إضافات خرسانة (ملدنات)', unit: 'لتر' },
];

async function main(): Promise<void> {
  let added = 0, skipped = 0;
  for (const it of ITEMS) {
    const exists = await prisma.inventoryItem.findFirst({ where: { code: it.code } });
    if (exists) { skipped++; continue; }
    await prisma.inventoryItem.create({ data: { ...it, qty: 0, minQty: 0 } });
    added++;
  }
  console.log(`✅ الجرد الافتتاحي: اتضاف ${added} صنف${skipped ? ` (اتخطى ${skipped} موجودين)` : ''} — كل الكميات صفر، سجّل الوارد الفعلي من الشاشة`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
