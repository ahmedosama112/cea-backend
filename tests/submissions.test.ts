import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';

const fakeXlsx = Buffer.from('PKfake-xlsx-content-for-test');

describe('تسليمات الكشوف المعتمدة', () => {
  let admin: TestUser;
  let eng: TestUser;
  let subId: string;

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    eng = await createEngineer(admin.token);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('المهندس يبعت كشف (ملف + بيانات) → حالة مُرسَل', async () => {
    const res = await request(app)
      .post('/api/submissions')
      .set(auth(eng.token))
      .field('contractorName', 'علاء أحمد محمود')
      .field('placeName', 'عمارة 27')
      .field('weekStart', '2026-08-12')
      .field('weekEnd', '2026-08-18')
      .field('total', '920')
      .field('recordsCount', '2')
      .field('engineerNote', 'كشف الأسبوع')
      .attach('file', fakeXlsx, 'سركي_علاء.xlsx');
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('SUBMITTED');
    expect(res.body.data.weekStart).toBe('2026-08-12');
    expect(Number(res.body.data.total)).toBe(920);
    subId = res.body.data.id;
  });

  it('كشف بمقاولين كتير (اسم متجمّع > 190 حرف) بيتقبل — كان بيرجّع 400 (8 سبتمبر 2026)', async () => {
    const many = Array.from({ length: 12 }, (_, i) => 'مقاول رقم ' + (i + 1) + ' عبد الرحمن توفيق').join('، ');
    expect(many.length).toBeGreaterThan(190);
    const res = await request(app).post('/api/submissions').set(auth(eng.token))
      .field('contractorName', many).field('placeName', '15 أماكن').field('weekStart', '2026-09-02')
      .field('weekEnd', '2026-09-08').field('total', '52032.5').field('recordsCount', '40')
      .attach('file', fakeXlsx, 'many.xlsx');
    expect(res.status).toBe(201);
    expect(res.body.data.contractorName).toBe(many);
    await request(app).delete(`/api/submissions/${res.body.data.id}`).set(auth(admin.token)); // ما يأثرش على عدّادات الاختبارات التالية
  });

  it('كشف معدات: kind=equipment بيتحفظ، والافتراضي labor', async () => {
    const res = await request(app)
      .post('/api/submissions')
      .set(auth(eng.token))
      .field('contractorName', 'محمد عبد الله للمعدات')
      .field('placeName', 'لودر كاتربيلر 950')
      .field('weekStart', '2026-08-20')
      .field('weekEnd', '2026-09-19')
      .field('total', '151.5')
      .field('recordsCount', '18')
      .field('kind', 'equipment')
      .attach('file', fakeXlsx, 'سركي_معدات.xlsx');
    expect(res.status).toBe(201);
    expect(res.body.data.kind).toBe('equipment');
    const first = await prisma.submission.findUnique({ where: { id: BigInt(subId) }, select: { kind: true } });
    expect(first!.kind).toBe('labor');
    const bad = await request(app).post('/api/submissions').set(auth(eng.token))
      .field('contractorName', 'x').field('weekStart', '2026-08-12').field('weekEnd', '2026-08-18').field('total', '1').field('recordsCount', '1').field('kind', 'other')
      .attach('file', fakeXlsx, 'x.xlsx');
    expect(bad.status).toBe(400);
    // تنظيف: الاختبارات اللي بعده بتعدّ الكشوف (كشف واحد للمهندس)
    const del = await request(app).delete(`/api/submissions/${res.body.data.id}`).set(auth(admin.token));
    expect(del.status).toBe(200);
  });

  it('بدون ملف = 400', async () => {
    const res = await request(app).post('/api/submissions').set(auth(eng.token)).field('contractorName', 'x').field('weekStart', '2026-08-12').field('weekEnd', '2026-08-18').field('total', '1').field('recordsCount', '1');
    expect(res.status).toBe(400);
  });

  it('المهندس يشوف تسليماته فقط؛ الأدمن يشوف الكل ويفلتر بالحالة', async () => {
    const mine = await request(app).get('/api/submissions/mine').set(auth(eng.token));
    expect(mine.body.data.length).toBe(1);
    const all = await request(app).get('/api/submissions').set(auth(admin.token));
    expect(all.body.data.length).toBe(1);
    expect(all.body.data[0].user.email).toBe('eng@test.com');
    const engAll = await request(app).get('/api/submissions').set(auth(eng.token));
    expect(engAll.status).toBe(403);
  });

  it('تنزيل الملف: صاحبه والأدمن فقط', async () => {
    const own = await request(app).get(`/api/submissions/${subId}/file`).set(auth(eng.token));
    expect(own.status).toBe(200);
    const adm = await request(app).get(`/api/submissions/${subId}/file`).set(auth(admin.token));
    expect(adm.status).toBe(200);
    const other = await createEngineer(admin.token, 'other@test.com');
    const stranger = await request(app).get(`/api/submissions/${subId}/file`).set(auth(other.token));
    expect(stranger.status).toBe(404);
  });

  it('الأدمن يعتمد/يرفض بملاحظة، والمهندس يشوف الحالة؛ المهندس لا يراجع', async () => {
    const rej = await request(app).patch(`/api/submissions/${subId}/review`).set(auth(admin.token)).send({ status: 'REJECTED', reviewNote: 'الإجمالي غلط' });
    expect(rej.status).toBe(200);
    expect(rej.body.data.status).toBe('REJECTED');
    const mine = await request(app).get('/api/submissions/mine').set(auth(eng.token));
    expect(mine.body.data[0].reviewNote).toBe('الإجمالي غلط');
    const engTry = await request(app).patch(`/api/submissions/${subId}/review`).set(auth(eng.token)).send({ status: 'APPROVED' });
    expect(engTry.status).toBe(403);
  });

  it('gsync: تسليم حد تاني أو غير موجود → 404، وبدون تفعيل ربط جوجل → 400', async () => {
    const other = await createEngineer(admin.token, 'gsync-other@test.com');
    const stranger = await request(app).post(`/api/submissions/${subId}/gsync`).set(auth(other.token));
    expect(stranger.status).toBe(404);
    const missing = await request(app).post('/api/submissions/999999/gsync').set(auth(admin.token));
    expect(missing.status).toBe(404);
    const disabled = await request(app).post(`/api/submissions/${subId}/gsync`).set(auth(eng.token));
    expect(disabled.status).toBe(400);
  });

  it('حذف تسليم: للأدمن فقط — المهندس ممنوع في أي حالة، والأدمن يقدر يفلتر كشوف حساب معيّن', async () => {
    const del = await request(app).delete(`/api/submissions/${subId}`).set(auth(eng.token));
    expect(del.status).toBe(403);
    await request(app).patch(`/api/submissions/${subId}/review`).set(auth(admin.token)).send({ status: 'SUBMITTED' });
    const del2 = await request(app).delete(`/api/submissions/${subId}`).set(auth(eng.token));
    expect(del2.status).toBe(403); // حتى وهو "مُرسَل" — مش من التسليمات
    const byUser = await request(app).get(`/api/submissions?userId=${eng.id}`).set(auth(admin.token));
    expect(byUser.status).toBe(200);
    expect(byUser.body.data.some((s: { id: string }) => s.id === subId)).toBe(true);
    const adm = await request(app).delete(`/api/submissions/${subId}`).set(auth(admin.token));
    expect(adm.status).toBe(200);
    const gone = await request(app).get('/api/submissions/mine').set(auth(eng.token));
    expect(gone.body.data.some((s: { id: string }) => s.id === subId)).toBe(false);
  });
});
