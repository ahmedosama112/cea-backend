/* eslint-disable no-console */
// استعادة كاملة لقاعدة البيانات من ملف الباك اب اليومي (cea-db-backup-*.json من Google Drive)
//
// التشغيل:
//   npx ts-node --transpile-only scripts/restore-backup.ts "<مسار الملف>" [--wipe]
//
// - بيرجّع النظام كله بضربة واحدة: كل الحسابات (بنفس الإيميلات وكلمات السر المشفرة) وكل بياناتها
//   بنفس الأرقام الأصلية — كل مهندس يسجل دخول عادي ويلاقي كل حاجته زي لحظة الباك اب.
// - يرفض أي جدول هدف غير فارغ إلا مع --wipe؛ الاستعادة والمسح داخل transaction واحدة.
// - بيطبع تقرير مقارنة (ملف ↔ قاعدة) في الآخر ويفشل بكود خطأ لو الأعداد مش متطابقة.
//
// ملاحظات:
// - القاعدة المستهدفة هي اللي في DATABASE_URL (ملف .env) — راجعها قبل التشغيل.
// - جلسات الدخول (refresh tokens) مش بتتحفظ في الباك اب — كل المستخدمين هيسجلوا دخول من جديد بس.
// - إصدار 2: مرر --files-dir=<مجلد الكائنات> لاستعادة uploads والتحقق من SHA-256. إصدار 1 يحتاج نسخة ملفات مستقلة.

import * as fs from 'fs';
import * as path from 'path';
import { BackupFileEntry, decodeBackupFile } from '../src/services/backupFiles';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

// ترتيب الإدراج يحترم الـ foreign keys (الآباء قبل الأبناء)
const INSERT_ORDER = [
  'users', 'files', 'accountSettings',
  // المشاريع بعد المستخدمين مباشرة (Submission/Place/UserProject بتشاور عليها)
  'projects', 'userProjects',
  'contractors', 'places', 'inspectors',
  // طلبات الإيجار بعد المقاولين والأماكن وقبل records (Record.rentRequestId بيشاور عليها)
  'rentRequests', 'rentRequestReviews',
  'items', 'itemStages', 'records', 'recordDeductions', 'irRecords', 'todos',
  'execRecords', 'execRecordStages', 'dailyRecords', 'equipmentRecords',
  // الكشوف قبل مراجعاتها وسطورها المشطوبة/المعدّلة وتعليقاتها
  'submissions', 'submissionReviews', 'submissionRowRejections', 'submissionRowEdits', 'submissionComments',
  'submissionLaborDays', 'submissionRevisions', 'appConfig',
  // المخازن: الأصناف قبل الطلبات، والطلبات قبل الحركات (stockMoves بتشاور على issueRequestId)
  'inventoryItems', 'issueRequests', 'issueRequestLines', 'stockMoves', 'purchaseRequests',
  // التنبيهات: التعريف قبل المستقبلين و"تم"
  'notifications', 'notificationTargets', 'notificationReads',
] as const;
type TableKey = (typeof INSERT_ORDER)[number];

// delegate مقابل كل جدول في الملف
const makeDelegates = (prisma: Prisma.TransactionClient): Record<TableKey, { createMany: (args: { data: unknown[] }) => Promise<{ count: number }>; deleteMany: (args?: unknown) => Promise<{ count: number }>; count: () => Promise<number> }> => ({
  users: prisma.user, files: prisma.file, accountSettings: prisma.accountSettings,
  projects: prisma.project, userProjects: prisma.userProject,
  rentRequests: prisma.rentRequest, rentRequestReviews: prisma.rentRequestReview,
  contractors: prisma.contractor, places: prisma.place, inspectors: prisma.inspector,
  items: prisma.item, itemStages: prisma.itemStage, records: prisma.record,
  recordDeductions: prisma.recordDeduction, irRecords: prisma.irRecord, todos: prisma.todo,
  execRecords: prisma.execRecord, execRecordStages: prisma.execRecordStage,
  dailyRecords: prisma.dailyRecord, submissions: prisma.submission,
  equipmentRecords: prisma.equipmentRecord,
  submissionReviews: prisma.submissionReview, submissionRowRejections: prisma.submissionRowRejection,
  submissionRowEdits: prisma.submissionRowEdit, submissionComments: prisma.submissionComment,
  submissionLaborDays: prisma.submissionLaborDays,
  submissionRevisions: prisma.submissionRevision,
  appConfig: prisma.appConfig,
  inventoryItems: prisma.inventoryItem, issueRequests: prisma.issueRequest,
  issueRequestLines: prisma.issueRequestLine, stockMoves: prisma.stockMove,
  purchaseRequests: prisma.purchaseRequest,
  notifications: prisma.notification, notificationTargets: prisma.notificationTarget,
  notificationReads: prisma.notificationRead,
} as never);

// نوع كل عمود بيتقرا من الـschema نفسه (DMMF) — الحدس على أساس اسم العمود (id/*Id = BigInt)
// كان بيقع على جداول معرّفها Int زي projects. المفتاح في الملف = اسم الجدول بالـsnake_case.
const snake = (k: string): string => k.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase();
const FIELD_TYPES: Record<string, Record<string, string>> = {};
for (const m of Prisma.dmmf.datamodel.models) {
  const types: Record<string, string> = {};
  for (const f of m.fields) if (f.kind === 'scalar' || f.kind === 'enum') types[f.name] = f.type;
  FIELD_TYPES[m.dbName ?? m.name] = types;
}

// تحويل صف من الـ JSON لصيغة Prisma:
// - الأرقام الكبيرة اتخزنت كنصوص (BigInt.toJSON) → نرجّعها حسب نوع العمود (BigInt ولا Int)
// - التواريخ ISO نصوص → Prisma بيقبلها زي ما هي
// - القيم null بنشيلها (الأعمدة الاختيارية default NULL أصلًا — وده بيتجنب مشكلة Json null في Prisma)
function toRow(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const types = FIELD_TYPES[snake(key)] ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    const t = types[k];
    if ((typeof v === 'string' || typeof v === 'number') && t === 'BigInt') out[k] = BigInt(v);
    else if ((typeof v === 'string' || typeof v === 'number') && t === 'Int') out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

async function main(): Promise<void> {
  const [filePath, ...flags] = process.argv.slice(2);
  const wipe = flags.includes('--wipe');
  if (!filePath) { console.error('الاستخدام: npx ts-node --transpile-only scripts/restore-backup.ts "<مسار الملف>" [--wipe]'); process.exit(1); }
  if (!fs.existsSync(filePath)) { console.error(`الملف غير موجود: ${filePath}`); process.exit(1); }

  const dump = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { fileManifest?: BackupFileEntry[]; version?: number; createdAt?: string; tables?: Record<string, Array<Record<string, unknown>>> };
  if (!dump.tables || !Array.isArray(dump.tables.users)) { console.error('صيغة الملف غير متوقعة — ده مش ملف cea-db-backup-*.json (بتاع الباك اب اليومي)'); process.exit(1); }
  console.log(`📦 ملف باك اب بتاريخ: ${dump.createdAt ?? '؟'} — مستخدمين: ${dump.tables.users.length}`);

  // ⚠ حارس: أي جدول موجود في الملف ومش في INSERT_ORDER كان بيتخطى في صمت والاستعادة تقول "اكتملت"
  // وهي مضيّعاه (ده اللي حصل مع سراكي المعدات وسجل الاعتمادات). الوقوف هنا أرخص من اكتشافها بعدين.
  const unknown = Object.keys(dump.tables).filter((k) => !(INSERT_ORDER as readonly string[]).includes(k));
  if (unknown.length) {
    console.error(`⛔ الملف فيه جداول السكربت ده مايعرفهاش: ${unknown.join(', ')}`);
    console.error('   ضيفها في INSERT_ORDER وDELEGATES (بترتيب يحترم الـFK) وأعد التشغيل — الاستعادة من غيرها ناقصة.');
    process.exit(1);
  }
  const emptyInFile = (INSERT_ORDER as readonly string[]).filter((k) => !dump.tables![k]);
  if (emptyInFile.length) console.warn(`⚠ جداول مش موجودة في الملف (نسخة أقدم من إضافتها؟): ${emptyInFile.join(', ')}`);

  // Verify every object before modifying either the database or uploads.
  const filesArg = flags.find((flag) => flag.startsWith('--files-dir='));
  const sourceDir = filesArg ? path.resolve(filesArg.slice('--files-dir='.length)) : undefined;
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
  const verified: Array<{ entry: BackupFileEntry; source: string; target: string }> = [];
  if (dump.version === 2) {
    if (!Array.isArray(dump.fileManifest)) throw new Error('Missing file manifest');
    const expected = new Set((dump.tables.files || []).map((row) => row.filePath));
    for (const entry of dump.fileManifest) {
      if (!expected.delete(entry.filePath) || !/^[a-f0-9]{64}\.json$/.test(entry.objectName) || entry.objectName !== `${entry.sha256}.json`) throw new Error('Invalid file manifest');
      if (!sourceDir) throw new Error('Full restore requires --files-dir=<downloaded CEA Backup Files directory>');
      const target = path.resolve(uploadDir, entry.filePath);
      if (!target.startsWith(uploadDir + path.sep)) throw new Error('Invalid upload path');
      const source = path.join(sourceDir, entry.objectName);
      decodeBackupFile(fs.readFileSync(source, 'utf8'), entry);
      if (fs.existsSync(target)) throw new Error('Restore uploads into an empty directory; refusing to overwrite a file');
      verified.push({ entry, source, target });
    }
    if (expected.size) throw new Error('File manifest does not cover database files');
  } else {
    console.warn('Legacy database-only backup: uploads must be recovered separately.');
  }
  if (verified.length && fs.existsSync(uploadDir) && fs.readdirSync(uploadDir).length) throw new Error('Full restore requires an empty UPLOAD_DIR');
  const createdFiles: string[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      const DELEGATES = makeDelegates(tx);
      if (!wipe) {
        for (const key of INSERT_ORDER) {
          if (await DELEGATES[key].count()) throw new Error(`Target table ${key} is not empty; restore into an empty database or explicitly use --wipe on a disposable target.`);
        }
      }
      if (wipe) {
        console.log('🗑 مسح كل الجداول (ترتيب عكسي للعلاقات)...');
        // جداول الجلسات مش في الباك اب لكن لازم تتمسح مع المستخدمين
        await tx.refreshToken.deleteMany();
        await tx.passwordResetToken.deleteMany();
        for (const key of [...INSERT_ORDER].reverse()) {
          // accountSettings مرتبط بـ files (توقيع) — نفك الربط الأول عشان ترتيب المسح ما يتعقدش
          if (key === 'accountSettings') await tx.accountSettings.updateMany({ data: { signatureFileId: null } });
          await DELEGATES[key].deleteMany();
        }
      }

      console.log('⬆️ استيراد الجداول...');
      const CHUNK = 500;
      // users بتشاور على نفسها (معتمد الـTL/CM/PM مستخدم تاني) — مفيش ترتيب إدراج بيحل ده،
      // فبندرجهم من غير المعتمدين وبنرجّع الربط في مرحلة تانية بعد ما كلهم يبقوا موجودين.
      const USER_SELF_REFS = ['approverTlId', 'approverCmId', 'approverPmId', 'approverSrId'] as const;
      const userApprovers: Array<{ id: bigint; tl: bigint | null; cm: bigint | null; pm: bigint | null; sr: bigint | null }> = [];
      for (const key of INSERT_ORDER) {
        const rows = (dump.tables[key] ?? []).map((r) => toRow(r, key));
        if (key === 'users') {
          for (const row of rows) {
            const held: Record<string, bigint | null> = {};
            let any = false;
            for (const f of USER_SELF_REFS) {
              held[f] = (row[f] as bigint | undefined) ?? null;
              if (row[f] !== undefined) { delete row[f]; any = true; }
            }
            if (any) userApprovers.push({ id: row.id as bigint, tl: held.approverTlId, cm: held.approverCmId, pm: held.approverPmId, sr: held.approverSrId });
          }
        }
        // accountSettings بيشاور على files بتوقيعه — files بتتدرج قبله في الترتيب فمفيش مشكلة
        for (let i = 0; i < rows.length; i += CHUNK) {
          await DELEGATES[key].createMany({ data: rows.slice(i, i + CHUNK) });
        }
        console.log(`   ${key}: ${rows.length}`);
      }

      if (userApprovers.length) {
        // SQL خام عن قصد: prisma.user.update كان هيحدّث updated_at (@updatedAt) ويضيّع تاريخ النسخة الأصلي
        for (const u of userApprovers) {
          await tx.$executeRaw`UPDATE users SET approver_tl_id = ${u.tl}, approver_cm_id = ${u.cm}, approver_pm_id = ${u.pm}, approver_sr_id = ${u.sr} WHERE id = ${u.id}`;
        }
        console.log(`   ↩ ربط معتمدي المستخدمين: ${userApprovers.length}`);
      }

      console.log('\n🔍 مقارنة (ملف ↔ قاعدة):');
      let mismatch = false;
      for (const key of INSERT_ORDER) {
        const want = (dump.tables[key] ?? []).length;
        const got = await DELEGATES[key].count();
        const ok = want === got;
        if (!ok) mismatch = true;
        console.log(`   ${ok ? '✅' : '❌'} ${key}: ملف=${want} قاعدة=${got}`);
      }
      if (mismatch) throw new Error('Restore row counts do not match');
      for (const { entry, source, target } of verified) {
        const bytes = decodeBackupFile(fs.readFileSync(source, 'utf8'), entry);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
        createdFiles.push(target);
      }
    }, { timeout: 300_000, maxWait: 10_000 });
  } catch (error) {
    for (const target of createdFiles) fs.unlinkSync(target);
    throw error;
  }
  console.log('\n✅ الاستعادة اكتملت — كل الحسابات وبياناتها رجعت بنفس الأرقام. المستخدمون يسجلون دخولهم من جديد فقط.');
}

main()
  .catch((e) => { console.error('⛔ فشل الاستعادة:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
