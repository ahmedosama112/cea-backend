import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';

const baseRecord = {
  day: 'الاثنين',
  date: '2026-08-17',
  contractor: 'علاء أحمد محمود',
  spec: 'مبيض محارة',
  qty: 3,
  qtyType: 'يومية',
  price: 500,
  discount: 100,
  place: 'عمارة 27',
  notes: 'ملاحظة اختبار',
  deductOn: ['حمدي صديق محمد', 'عطا محمد بخيت'],
  deductNote: 'سلفة',
};

describe('Records (سراكي)', () => {
  let admin: TestUser;
  let eng: TestUser;

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    eng = await createEngineer(admin.token);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  let recordId: string;

  it('الإنشاء يحسب total على السيرفر ويتجاهل أي total مُرسل', async () => {
    const res = await request(app)
      .post('/api/records')
      .set(auth(admin.token))
      .send({ ...baseRecord, total: 999999 });
    expect(res.status).toBe(201);
    const d = res.body.data;
    expect(Number(d.total)).toBe(3 * 500 - 100); // 1400
    expect(d.qtyType).toBe('يومية');
    expect(d.deductOn).toEqual(baseRecord.deductOn);
    expect(d.date).toBe('2026-08-17');
    recordId = d.id;
  });

  it('ربط المقاول بالاسم snapshot حتى بدون صف مقاول فعلي', async () => {
    const row = await prisma.record.findUnique({ where: { id: BigInt(recordId) } });
    expect(row!.contractorName).toBe(baseRecord.contractor);
    expect(row!.contractorId).toBeNull(); // لا يوجد مقاول بهذا الاسم في الجدول بعد
  });

  it('التعديل يعيد الحساب ويستبدل الخصومات بالكامل', async () => {
    const res = await request(app)
      .put(`/api/records/${recordId}`)
      .set(auth(admin.token))
      .send({ ...baseRecord, qty: 5, discount: 0, deductOn: ['واحد بس'] });
    expect(res.status).toBe(200);
    expect(Number(res.body.data.total)).toBe(2500);
    expect(res.body.data.deductOn).toEqual(['واحد بس']);
  });

  it('الفلترة بالتاريخ والمقاول والمكان + pagination', async () => {
    await request(app).post('/api/records').set(auth(admin.token))
      .send({ ...baseRecord, date: '2026-07-01', contractor: 'مقاول تاني' });
    await request(app).post('/api/records').set(auth(admin.token))
      .send({ ...baseRecord, date: '2026-06-01', place: 'عمارة 28' });

    const byDate = await request(app).get('/api/records?date_from=2026-08-01').set(auth(admin.token));
    expect(byDate.body.data.total).toBe(1);

    const byContractor = await request(app)
      .get('/api/records?contractor=' + encodeURIComponent('مقاول تاني'))
      .set(auth(admin.token));
    expect(byContractor.body.data.total).toBe(1);
    expect(byContractor.body.data.rows[0].date).toBe('2026-07-01');

    const paged = await request(app).get('/api/records?limit=2&page=2&sort=date&dir=asc').set(auth(admin.token));
    expect(paged.body.data.total).toBe(3);
    expect(paged.body.data.rows.length).toBe(1);
  });

  it('toggle-done يقلب الحالة', async () => {
    const t1 = await request(app).patch(`/api/records/${recordId}/toggle-done`).set(auth(admin.token));
    expect(t1.body.data.done).toBe(true);
    const t2 = await request(app).patch(`/api/records/${recordId}/toggle-done`).set(auth(admin.token));
    expect(t2.body.data.done).toBe(false);
  });

  it('العزل: مستخدم آخر لا يرى ولا يعدل ولا يحذف سجلات غيره', async () => {
    const list = await request(app).get('/api/records').set(auth(eng.token));
    expect(list.body.data.total).toBe(0);

    const get = await request(app).get(`/api/records/${recordId}`).set(auth(eng.token));
    expect(get.status).toBe(404);

    const put = await request(app).put(`/api/records/${recordId}`).set(auth(eng.token)).send(baseRecord);
    expect(put.status).toBe(404);

    const del = await request(app).delete(`/api/records/${recordId}`).set(auth(eng.token));
    expect(del.status).toBe(404);
  });

  it('validation: تاريخ بصيغة غلط وكمية سالبة = 400', async () => {
    const badDate = await request(app).post('/api/records').set(auth(admin.token))
      .send({ ...baseRecord, date: '17-08-2026' });
    expect(badDate.status).toBe(400);

    const badQty = await request(app).post('/api/records').set(auth(admin.token))
      .send({ ...baseRecord, qty: -1 });
    expect(badQty.status).toBe(400);
  });

  it('الحذف يحذف السجل وخصوماته (cascade)', async () => {
    const del = await request(app).delete(`/api/records/${recordId}`).set(auth(admin.token));
    expect(del.status).toBe(200);
    const deductions = await prisma.recordDeduction.count({ where: { recordId: BigInt(recordId) } });
    expect(deductions).toBe(0);
  });
});
