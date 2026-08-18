/* eslint-disable no-console */
// استيراد ملف النسخة الاحتياطية للتطبيق (CEA_backup_*.json) إلى MySQL
//
// التشغيل:
//   npx ts-node --transpile-only scripts/import-backup.ts "<مسار الملف>" <إيميل المستخدم> [--wipe]
//
// - آمن: يرفض الاستيراد لو المستخدم عنده بيانات موجودة، إلا مع --wipe (يمسح بيانات هذا المستخدم فقط ثم يستورد)
// - Repeatable: نفس الملف + --wipe = نفس النتيجة دائمًا
// - Logged: يطبع تقرير مقارنة (ملف ↔ DB) في النهاية ويفشل بكود خطأ لو الأعداد مش متطابقة
//
// فروقات الصيغة القديمة التي يعالجها:
// - records بدون qtyType → 'يومية' (الافتراضي في التطبيق)
// - deductOn قد يكون نص/undefined/مصفوفة → يُطبَّع لمصفوفة (نفس منطق mapSupaRecord في app.js)
// - exec stages بصيغة قديمة {name, weight, done: 0-100, contrib} → {name, pct: weight, done: done>=100}
//   (مع أولوية لمصفوفة stageDone الحديثة لو موجودة)

import * as fs from 'fs';
import { PrismaClient, Prisma, RateType } from '@prisma/client';

const prisma = new PrismaClient();

const AR_TO_ENUM: Record<string, RateType> = { يومية: 'DAILY', ساعة: 'HOURLY', مقطوعية: 'LUMPSUM' };

interface BackupFile {
  version?: string;
  date?: string;
  records: Array<Record<string, unknown>>;
  irRecords: Array<Record<string, unknown>>;
  todos: Array<Record<string, unknown>>;
  contractors: Array<Record<string, unknown>>;
  places: string[];
  inspectors: string[];
  items: Array<Record<string, unknown>>;
  dailyRecords: Array<Record<string, unknown>>;
  execRecords: Array<Record<string, unknown>>;
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function ymd(v: unknown): Date {
  const s = str(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`تاريخ غير صالح: "${s}"`);
  return new Date(s);
}
// نفس منطق التطبيق: deductOn قد يكون مصفوفة أو نص JSON أو نص عادي أو غير موجود
function normDeductOn(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  const s = str(v);
  if (!s) return [];
  try {
    const p = JSON.parse(s);
    return Array.isArray(p) ? p.map(str).filter(Boolean) : [s];
  } catch {
    return [s];
  }
}

async function main() {
  const [filePath, email, ...flags] = process.argv.slice(2);
  if (!filePath || !email) {
    console.error('الاستخدام: npx ts-node scripts/import-backup.ts "<مسار الملف>" <الإيميل> [--wipe]');
    process.exit(1);
  }
  const wipe = flags.includes('--wipe');

  const raw = fs.readFileSync(filePath, 'utf8');
  const b: BackupFile = JSON.parse(raw);

  // ── التحقق قبل الاستيراد ──
  for (const key of ['records', 'irRecords', 'todos', 'contractors', 'places', 'inspectors', 'items', 'dailyRecords', 'execRecords'] as const) {
    if (!Array.isArray(b[key])) throw new Error(`الملف ناقص أو تالف — الحقل "${key}" ليس مصفوفة`);
  }
  const recIds = b.records.map((r) => r.id);
  if (new Set(recIds).size !== recIds.length) throw new Error('IDs مكررة في records — راجع الملف');
  console.log(`📄 الملف: version=${b.version ?? '?'} date=${b.date ?? '?'}`);
  console.log(
    `   محتوى: ${b.records.length} سجل، ${b.irRecords.length} IR، ${b.todos.length} مهمة، ${b.contractors.length} مقاول، ` +
      `${b.places.length} مكان، ${b.inspectors.length} استشاري، ${b.items.length} بند، ${b.dailyRecords.length} تقرير يومي، ${b.execRecords.length} موقف تنفيذي`,
  );

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) throw new Error(`المستخدم ${email} غير موجود — أنشئه أولاً (seed أو register)`);

  const existingRecords = await prisma.record.count({ where: { userId: user.id } });
  if (existingRecords > 0 && !wipe) {
    throw new Error(`المستخدم عنده ${existingRecords} سجل بالفعل — أعد التشغيل مع --wipe لمسح بياناته أولاً ثم الاستيراد`);
  }

  if (wipe) {
    console.log('🧹 مسح البيانات الحالية لهذا المستخدم (السجلات/IR/المهام/البنود/المواقف/المقاولين/الأماكن/الاستشاريين)...');
    // الترتيب يراعي الـ foreign keys؛ حذف مقيّد بـ userId فقط — لا يلمس مستخدمين آخرين
    await prisma.$transaction([
      prisma.record.deleteMany({ where: { userId: user.id } }),
      prisma.irRecord.deleteMany({ where: { userId: user.id } }),
      prisma.todo.deleteMany({ where: { userId: user.id } }),
      prisma.execRecord.deleteMany({ where: { userId: user.id } }),
      prisma.dailyRecord.deleteMany({ where: { userId: user.id } }),
      prisma.item.deleteMany({ where: { userId: user.id } }),
      prisma.contractor.deleteMany({ where: { userId: user.id } }),
      prisma.place.deleteMany({ where: { userId: user.id } }),
      prisma.inspector.deleteMany({ where: { userId: user.id } }),
    ]);
  }

  // ── 1. البيانات المرجعية ──
  for (const c of b.contractors) {
    await prisma.contractor.create({
      data: {
        userId: user.id,
        name: str(c.name),
        spec: str(c.spec) || '—',
        rate: str(c.rate) ? new Prisma.Decimal(num(c.rate)) : null,
        rateType: AR_TO_ENUM[str(c.rateType)] ?? 'DAILY',
      },
    });
  }
  for (const name of b.places) await prisma.place.create({ data: { userId: user.id, name: str(name) } });
  for (const name of b.inspectors) await prisma.inspector.create({ data: { userId: user.id, name: str(name) } });
  for (const it of b.items) {
    const stages = Array.isArray(it.stages) ? (it.stages as Array<Record<string, unknown>>) : [];
    await prisma.item.create({
      data: {
        userId: user.id,
        category: str(it.cat) || 'عام',
        name: str(it.name),
        stages: { create: stages.map((s, i) => ({ name: str(s.name), pct: num(s.pct ?? s.weight), position: i })) },
      },
    });
  }
  console.log('✅ 1/4 البيانات المرجعية (مقاولين/أماكن/استشاريين/بنود)');

  // خرائط الربط بالاسم → ID (لملء contractorId/placeId في السجلات)
  const contractorId = new Map(
    (await prisma.contractor.findMany({ where: { userId: user.id } })).map((c) => [c.name, c.id]),
  );
  const placeId = new Map((await prisma.place.findMany({ where: { userId: user.id } })).map((p) => [p.name, p.id]));

  // ── 2. السجلات (على دفعات 50) ──
  const BATCH = 50;
  for (let i = 0; i < b.records.length; i += BATCH) {
    const slice = b.records.slice(i, i + BATCH);
    await prisma.$transaction(
      slice.map((r) => {
        const qty = num(r.qty), price = num(r.price), discount = num(r.discount);
        return prisma.record.create({
          data: {
            userId: user.id,
            day: str(r.day),
            date: ymd(r.date),
            contractorName: str(r.contractor),
            contractorId: contractorId.get(str(r.contractor)) ?? null,
            placeName: str(r.place),
            placeId: placeId.get(str(r.place)) ?? null,
            spec: str(r.spec),
            qty: new Prisma.Decimal(qty),
            qtyType: AR_TO_ENUM[str(r.qtyType)] ?? 'DAILY',
            price: new Prisma.Decimal(price),
            discount: new Prisma.Decimal(discount),
            // نحفظ total من الملف كما هو (وليس إعادة حساب) — الحفاظ على البيانات التاريخية حرفيًا
            total: new Prisma.Decimal(num(r.total)),
            notes: str(r.notes),
            deductNote: str(r.deductNote),
            done: Boolean(r.done),
            deductions: { create: normDeductOn(r.deductOn).map((name) => ({ name })) },
          },
        });
      }),
    );
    console.log(`   سجلات: ${Math.min(i + BATCH, b.records.length)}/${b.records.length}`);
  }
  console.log('✅ 2/4 السجلات');

  // ── 3. IR + المهام ──
  for (const r of b.irRecords) {
    await prisma.irRecord.create({
      data: {
        userId: user.id, date: ymd(r.date), item: str(r.item), place: str(r.place),
        inspector: str(r.inspector), status: str(r.status), notes: str(r.notes),
      },
    });
  }
  for (const t of b.todos) {
    await prisma.todo.create({
      data: {
        userId: user.id, date: ymd(t.date), notes: str(t.notes), place: str(t.place),
        priority: str(t.priority) || 'عادي', done: Boolean(t.done),
      },
    });
  }
  console.log('✅ 3/4 IR والمهام');

  // ── 4. الموقف التنفيذي + التقارير اليومية ──
  for (const e of b.execRecords) {
    const stages = Array.isArray(e.stages) ? (e.stages as Array<Record<string, unknown>>) : [];
    const stageDone = Array.isArray(e.stageDone) ? (e.stageDone as unknown[]) : [];
    await prisma.execRecord.create({
      data: {
        userId: user.id,
        item: str(e.item), place: str(e.place),
        pct: new Prisma.Decimal(num(e.pct)),
        notes: str(e.notes),
        stages: {
          create: stages.map((s, i) => ({
            name: str(s.name),
            pct: num(s.pct ?? s.weight), // الصيغة القديمة تسمي النسبة weight
            done: stageDone.length > i ? Boolean(stageDone[i]) : num(s.done) >= 100,
          })),
        },
      },
    });
  }
  for (const d of b.dailyRecords) {
    // الصور (photo base64) لا تُستورد هنا — تحتاج رفعًا لجدول files، وستُعالج ضمن مرحلة الواجهة
    await prisma.dailyRecord.create({
      data: {
        userId: user.id, date: ymd(d.date), day: str(d.day), contractor: str(d.contractor),
        spec: str(d.spec), work: str(d.work), place: str(d.place),
      },
    });
  }
  console.log('✅ 4/4 الموقف التنفيذي والتقارير اليومية');

  // ── المقارنة النهائية (ملف ↔ DB) ──
  const counts = {
    records: await prisma.record.count({ where: { userId: user.id } }),
    irRecords: await prisma.irRecord.count({ where: { userId: user.id } }),
    todos: await prisma.todo.count({ where: { userId: user.id } }),
    contractors: await prisma.contractor.count({ where: { userId: user.id } }),
    places: await prisma.place.count({ where: { userId: user.id } }),
    inspectors: await prisma.inspector.count({ where: { userId: user.id } }),
    items: await prisma.item.count({ where: { userId: user.id } }),
    dailyRecords: await prisma.dailyRecord.count({ where: { userId: user.id } }),
    execRecords: await prisma.execRecord.count({ where: { userId: user.id } }),
  };
  const totalFile = b.records.reduce((s, r) => s + num(r.total), 0);
  const totalDb = await prisma.record.aggregate({ where: { userId: user.id }, _sum: { total: true } });

  console.log('\n📊 المقارنة النهائية (الملف ↔ قاعدة البيانات):');
  let ok = true;
  for (const [k, dbCount] of Object.entries(counts)) {
    const fileCount = (b[k as keyof BackupFile] as unknown[]).length;
    const match = fileCount === dbCount;
    if (!match) ok = false;
    console.log(`   ${match ? '✅' : '❌'} ${k}: ملف=${fileCount} ↔ DB=${dbCount}`);
  }
  const sumMatch = Math.abs(totalFile - Number(totalDb._sum.total ?? 0)) < 0.01;
  if (!sumMatch) ok = false;
  console.log(`   ${sumMatch ? '✅' : '❌'} مجموع الإجماليات المالية: ملف=${totalFile} ↔ DB=${Number(totalDb._sum.total ?? 0)}`);

  if (!ok) {
    console.error('\n❌ الاستيراد غير مكتمل — الأعداد غير متطابقة');
    process.exit(2);
  }
  console.log('\n🎉 الاستيراد اكتمل والتحقق ناجح');
}

main()
  .catch((e) => {
    console.error('❌ فشل الاستيراد:', e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
