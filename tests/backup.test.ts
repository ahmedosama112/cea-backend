import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { app, prisma, request, resetDb, createAdmin, auth } from './helpers';
import { dumpDatabase, missingBackupModels, BACKUP_ORDER, __backupTest } from '../src/services/backup';

// النسخة الاحتياطية اليومية — الاختبار الأساسي هنا: **مفيش جدول في الـschema بره النسخة**
// (سراكي المعدات وسجل الاعتمادات فضلوا برّه النسخة شهور والاستعادة كانت بتقول "اكتملت")

describe('Backup (النسخة الاحتياطية)', () => {
  let adminToken = '';

  beforeAll(async () => {
    await resetDb();
    adminToken = (await createAdmin()).token;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    __backupTest.resetCoordinator();
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

  it('بيحفظ حالة طويلة كـ JSON صالح وفي حدود 900 حرف', async () => {
    await __backupTest.recordBackupStatus(false, (`سطر "quoted" \\ path\n\u0000🙂 `.repeat(500)));
    const row = await prisma.appConfig.findUniqueOrThrow({ where: { key: 'lastBackupStatus' } });
    const parsed = JSON.parse(row.value) as { ok: boolean; detail: string };
    expect(row.value.length).toBeLessThanOrEqual(900);
    expect(parsed.ok).toBe(false);
    expect(parsed.detail).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(Array.from(parsed.detail).length).toBeLessThanOrEqual(700);
  });

  it('backup-status ما يقعش مع قيمة legacy JSON مقطوعة', async () => {
    await prisma.appConfig.upsert({
      where: { key: 'lastBackupStatus' },
      update: { value: '{"at":"قديم","detail":"مقطوع' },
      create: { key: 'lastBackupStatus', value: '{"at":"قديم","detail":"مقطوع' },
    });
    const res = await request(app).get('/api/admin/backup-status').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ at: null, ok: false, detail: 'حالة نسخة احتياطية قديمة غير مكتملة' });
  });

  it('بيستخدم manual redirect ويتبع فقط script.googleusercontent.com', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: 'https://script.googleusercontent.com/macros/echo?token=hidden' },
      }))
      .mockResolvedValueOnce(new Response('<html>missing</html>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await __backupTest.uploadBackup('{}', 'backup.json');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(result).toMatchObject({ ok: false, kind: 'content-redirect-failed', retryable: true });
  });

  it('تحويل تاني من content host (عطل جوجل متقطع) يتصنف retryable', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: 'https://script.googleusercontent.com/macros/echo?token=hidden' },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: 'https://accounts.google.com/somewhere' },
      }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await __backupTest.uploadBackup('{}', 'backup.json');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: false, kind: 'content-redirect-failed', retryable: true });
  });

  it('يقبل JSON success بعد 303 من content host', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, {
        status: 303,
        headers: { location: 'https://script.googleusercontent.com/macros/echo?token=hidden' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, fileUrl: 'https://drive.example/file' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await __backupTest.uploadBackup('{}', 'backup.json');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, kind: 'success', retryable: false });
  });

  it('ما بيتبعش redirect لهوست غير مصرح وبيذكر الهوست فقط', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'https://evil.example/private/path?secret=value' },
    }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await __backupTest.uploadBackup('{}', 'backup.json');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, kind: 'unexpected-redirect', retryable: false });
    expect(result.detail).toContain('evil.example');
    expect(result.detail).not.toContain('/private');
    expect(result.detail).not.toContain('secret=value');
  });

  it('اللوج لا يحتوي request body أو مسار ورابط التحويل الكامل', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'https://evil.example/private/path?secret=value' },
    }));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await __backupTest.uploadBackup('{"private":"payload"}', 'private-name.json');

    const requestBody = String(fetchMock.mock.calls[0][1]?.body);
    const logged = errorLog.mock.calls.flat().join(' ');
    expect(logged).not.toContain(requestBody);
    expect(logged).not.toContain('/private/path');
    expect(logged).not.toContain('secret=value');
  });

  it.each([
    ['HTML مباشر', new Response('<html>busy</html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'http-non-json-before-content'],
    ['HTTP 503', new Response('busy', { status: 503, headers: { 'content-type': 'text/plain' } }), 'http-5xx'],
  ])('%s يتصنف retryable', async (_label, response, kind) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await __backupTest.uploadBackup('{}', 'backup.json');

    expect(result).toMatchObject({ ok: false, kind, retryable: true });
  });

  it.each([
    ['network', new Error('socket failed'), 'network'],
    ['abort', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'abort'],
  ])('%s failure يتصنف retryable', async (_label, error, kind) => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(error);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await __backupTest.uploadBackup('{}', 'backup.json');

    expect(result).toMatchObject({ ok: false, kind, retryable: true });
  });

  it('JSON واضح بـ ok:false لا يتعاد تلقائيًا حتى لو HTTP 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'رفض واضح' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await __backupTest.uploadBackup('{}', 'backup.json');

    expect(result).toMatchObject({ ok: false, detail: 'رفض واضح', kind: 'http-json-error', retryable: false });
  });

  it('المتصلين المتزامنين بيشاركوا نفس المحاولة', async () => {
    let finish: ((value: { ok: true; detail: string; kind: 'success'; retryable: false }) => void) | undefined;
    const attempt = vi.fn(() => new Promise<{ ok: true; detail: string; kind: 'success'; retryable: false }>((resolve) => { finish = resolve; }));

    const first = __backupTest.runCoordinatedBackup('scheduled', attempt);
    const second = __backupTest.runCoordinatedBackup('manual', attempt);
    expect(attempt).toHaveBeenCalledOnce();
    finish?.({ ok: true, detail: 'تم', kind: 'success', retryable: false });

    await expect(first).resolves.toEqual({ ok: true, detail: 'تم' });
    await expect(second).resolves.toEqual({ ok: true, detail: 'تم' });
  });

  it('الفشل المؤقت اليدوي يعلن ويشغّل محاولات 15 و60 دقيقة', async () => {
    vi.useFakeTimers();
    const attempt = vi.fn().mockResolvedValue({ ok: false, detail: 'مؤقت', kind: 'network' as const, retryable: true });

    const first = await __backupTest.runCoordinatedBackup('manual', attempt);
    expect(first.detail).toContain('محاولة 2 من 3 بعد ~15 دقيقة');
    expect(__backupTest.coordinatorState()).toMatchObject({ attempts: 1, retryTimers: 2 });

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(attempt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(45 * 60 * 1000);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(__backupTest.coordinatorState()).toMatchObject({ attempts: 3, retryTimers: 0 });
  });

  it('نجاح المحاولة الثانية يلغي محاولة الدقيقة 60', async () => {
    vi.useFakeTimers();
    const attempt = vi.fn()
      .mockResolvedValueOnce({ ok: false, detail: 'مؤقت', kind: 'network' as const, retryable: true })
      .mockResolvedValueOnce({ ok: true, detail: 'نجح', kind: 'success' as const, retryable: false });

    await __backupTest.runCoordinatedBackup('scheduled', attempt);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(__backupTest.coordinatorState().retryTimers).toBe(0);

    await vi.advanceTimersByTimeAsync(45 * 60 * 1000);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('المحاولة اليدوية بعد نجاح اليوم لا تستهلك حصة المحاولات', async () => {
    const success = vi.fn().mockResolvedValue({ ok: true, detail: 'نجح', kind: 'success' as const, retryable: false });
    const failure = vi.fn().mockResolvedValue({ ok: false, detail: 'فشل يدوي', kind: 'network' as const, retryable: true });

    await __backupTest.runCoordinatedBackup('scheduled', success);
    expect(__backupTest.coordinatorState().attempts).toBe(1);
    const manual = await __backupTest.runCoordinatedBackup('manual', failure);

    expect(failure).toHaveBeenCalledOnce();
    expect(manual).toEqual({ ok: false, detail: 'فشل يدوي' });
    expect(__backupTest.coordinatorState()).toMatchObject({ attempts: 1, retryTimers: 0 });
  });

  it('بعد فشل 3 محاولات تلقائية يقدر الأدمن يعمل محاولة يدوية ناجحة', async () => {
    vi.useFakeTimers();
    const failure = vi.fn().mockResolvedValue({ ok: false, detail: 'مؤقت', kind: 'network' as const, retryable: true });
    const success = vi.fn().mockResolvedValue({ ok: true, detail: 'نجح', kind: 'success' as const, retryable: false });

    await __backupTest.runCoordinatedBackup('scheduled', failure);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(failure).toHaveBeenCalledTimes(3);
    expect(__backupTest.coordinatorState()).toMatchObject({ attempts: 3, retryTimers: 0, successfulDate: '' });

    const manual = await __backupTest.runCoordinatedBackup('manual', success);
    expect(success).toHaveBeenCalledOnce();
    expect(manual).toEqual({ ok: true, detail: 'نجح' });
    expect(__backupTest.coordinatorState()).toMatchObject({ attempts: 3, retryTimers: 0, successfulDate: new Date().toISOString().slice(0, 10) });
  });

  it('بعد توقف اليوم بخطأ واضح المحاولة اليدوية تنفذ خارج الحصة بلا retry', async () => {
    const rejection = vi.fn().mockResolvedValue({ ok: false, detail: 'رفض واضح', kind: 'http-json-error' as const, retryable: false });
    const manualFailure = vi.fn().mockResolvedValue({ ok: false, detail: 'مؤقت', kind: 'network' as const, retryable: true });

    await __backupTest.runCoordinatedBackup('scheduled', rejection);
    const manual = await __backupTest.runCoordinatedBackup('manual', manualFailure);

    expect(manualFailure).toHaveBeenCalledOnce();
    expect(manual).toEqual({ ok: false, detail: 'مؤقت' });
    expect(__backupTest.coordinatorState()).toMatchObject({ attempts: 1, retryTimers: 0 });
  });
});
