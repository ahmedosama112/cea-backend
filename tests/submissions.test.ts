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

  it('حذف تسليم: مسموح فقط وهو مُرسَل (قبل المراجعة)', async () => {
    const del = await request(app).delete(`/api/submissions/${subId}`).set(auth(eng.token));
    expect(del.status).toBe(400); // اتراجع (مرفوض) — لا يُحذف
    await request(app).patch(`/api/submissions/${subId}/review`).set(auth(admin.token)).send({ status: 'SUBMITTED' });
    const del2 = await request(app).delete(`/api/submissions/${subId}`).set(auth(eng.token));
    expect(del2.status).toBe(200);
  });
});
