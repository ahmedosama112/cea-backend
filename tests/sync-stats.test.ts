import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';

// إحصاءات المزامنة لكل حساب في إدارة الحسابات: عدد السراكي على السيرفر + اللي بلّغه الجهاز

describe('إحصاءات المزامنة في إدارة الحسابات', () => {
  let admin: TestUser, eng: TestUser;

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    eng = await createEngineer(admin.token, 'eng@test.com');
    await request(app).post(`/api/admin/users/${eng.id}/contractors`).set(auth(admin.token)).send({ name: 'مقاول', rate: 100 });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('قائمة الحسابات بترجع عدد السراكي المسجلة على السيرفر لكل حساب', async () => {
    for (const d of ['2026-08-26', '2026-08-27']) {
      const r = await request(app).post('/api/records').set(auth(eng.token))
        .send({ day: 'الأربعاء', date: d, contractor: 'مقاول', spec: 'مبيض محارة', qty: 1, qtyType: 'يومية', price: 100, discount: 0, total: 100 });
      expect([200, 201]).toContain(r.status);
    }
    const list = await request(app).get('/api/admin/users').set(auth(admin.token));
    expect(list.status).toBe(200);
    const row = list.body.data.find((u: { id: string }) => u.id === eng.id);
    expect(row.recordsCount).toBe(2);
    expect(row.syncReportedAt).toBeNull();
  });

  it('الجهاز بيبلّغ إحصاءاته بعد المزامنة والأدمن بيشوفها', async () => {
    const rep = await request(app).post('/api/account/sync-stats').set(auth(eng.token)).send({ localRecords: 5, unsynced: 3 });
    expect(rep.status).toBe(200);
    const bad = await request(app).post('/api/account/sync-stats').set(auth(eng.token)).send({ localRecords: -1, unsynced: 0 });
    expect(bad.status).toBe(400);
    const list = await request(app).get('/api/admin/users').set(auth(admin.token));
    const row = list.body.data.find((u: { id: string }) => u.id === eng.id);
    expect(row.syncLocalRecords).toBe(5);
    expect(row.syncUnsynced).toBe(3);
    expect(row.syncReportedAt).toBeTruthy();
  });
});
