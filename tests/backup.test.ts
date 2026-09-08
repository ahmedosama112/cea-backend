import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma, resetDb, createAdmin } from './helpers';
import { dumpDatabase, missingBackupModels, BACKUP_ORDER } from '../src/services/backup';

// النسخة الاحتياطية اليومية — الاختبار الأساسي هنا: **مفيش جدول في الـschema بره النسخة**
// (سراكي المعدات وسجل الاعتمادات فضلوا برّه النسخة شهور والاستعادة كانت بتقول "اكتملت")

describe('Backup (النسخة الاحتياطية)', () => {
  beforeAll(async () => {
    await resetDb();
    await createAdmin();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('مفيش جدول في الـschema مش متغطّى بالنسخة ولا مستثنى صراحةً', () => {
    // لو الاختبار ده وقع: جدول جديد اتضاف للـschema — ضيفه في BACKUP_TABLES (وفي INSERT_ORDER
    // بتاع scripts/restore-backup.ts) أو في BACKUP_SKIP لو مالوش قيمة بعد الاستعادة
    expect(missingBackupModels()).toEqual([]);
  });

  it('كل جداول الـschema إما في النسخة أو في الاستثناء المقصود', () => {
    const all = Prisma.dmmf.datamodel.models.map((m) => m.name);
    // 31 جدول: 28 في النسخة + 3 مستثناة (جلسات + توكنات إعادة تعيين + سجل نشاط)
    expect(all.length).toBe(BACKUP_ORDER.length + 3);
  });

  it('الجداول اللي كانت ناقصة بقت في النسخة', () => {
    for (const k of ['equipmentRecords', 'submissionReviews', 'submissionRowRejections']) {
      expect(BACKUP_ORDER).toContain(k);
    }
  });

  it('الـdump بيرجّع كل الجداول المعلَنة بنفس المفاتيح', async () => {
    const dump = (await dumpDatabase()) as { tables: Record<string, unknown[]>; counts: Record<string, number> };
    expect(Object.keys(dump.tables).sort()).toEqual([...BACKUP_ORDER].sort());
    for (const k of BACKUP_ORDER) expect(Array.isArray(dump.tables[k])).toBe(true);
    expect(dump.counts.tables).toBe(BACKUP_ORDER.length);
    expect(dump.counts.users).toBe(1); // الأدمن اللي اتعمل في beforeAll
  });

  it('سركي معدات ومراجعة اعتماد بيوصلوا فعلًا للنسخة', async () => {
    const admin = await prisma.user.findFirstOrThrow();
    await prisma.equipmentRecord.create({
      data: {
        userId: admin.id, date: new Date('2026-09-08'), day: 'الثلاثاء', contractor: 'مورد معدات',
        equipment: 'لودر', place: 'السطح', timeFrom: '08:00', timeTo: '16:00', minutes: 480, works: 'حفر',
      },
    });
    const file = await prisma.file.create({
      data: { userId: admin.id, fileName: 'k.xlsx', filePath: 'x/k.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileSize: 10 },
    });
    const sub = await prisma.submission.create({
      data: {
        userId: admin.id, fileId: file.id, contractorName: 'مقاول', weekStart: new Date('2026-09-01'),
        weekEnd: new Date('2026-09-07'), total: 100, recordsCount: 1,
      },
    });
    await prisma.submissionReview.create({
      data: { submissionId: sub.id, level: 'team leader', decision: 'APPROVED', revision: 0, byUserId: admin.id },
    });

    const dump = (await dumpDatabase()) as { tables: Record<string, unknown[]>; counts: Record<string, number> };
    expect(dump.tables.equipmentRecords.length).toBe(1);
    expect(dump.tables.submissionReviews.length).toBe(1);
    expect(dump.counts.equipmentRecords).toBe(1);
    expect(dump.counts.submissionReviews).toBe(1);
  });
});
