import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';
import { normPlace } from '../src/services/analytics.service';

// تحليلات الأماكن — التجميع بيعدّي عبر حسابات كتير، فالمهم هنا حاجتين:
// 1) الأرقام بتتجمّع صح والكتابات المختلفة لنفس المكان بتتوحّد
// 2) نطاق الرؤية مفروض على السيرفر: المعتمد بيشوف مهندسينه بس، والمهندس نفسه بس

async function patchUser(adminToken: string, userId: string, body: Record<string, unknown>) {
  return request(app).patch(`/api/admin/users/${userId}`).set(auth(adminToken)).send(body);
}
async function setModules(adminToken: string, userId: string, mods: string[]) {
  return request(app).put(`/api/admin/users/${userId}/settings`).set(auth(adminToken)).send({ enabledModules: mods });
}
async function addRecord(token: string, r: { date: string; place: string; contractor: string; price: number; discount?: number }) {
  const res = await request(app).post('/api/records').set(auth(token)).send({
    day: 'الاثنين',
    date: r.date,
    contractor: r.contractor,
    place: r.place,
    qty: 1,
    qtyType: 'يومية',
    price: r.price,
    discount: r.discount ?? 0,
  });
  if (res.status !== 201) throw new Error('addRecord failed: ' + JSON.stringify(res.body));
  return res;
}
const placesOf = (body: { data: { rows: Array<{ name: string }> } }) => body.data.rows.map((r) => r.name);
const rowOf = (body: { data: { rows: Array<{ key: string }> } }, name: string) =>
  body.data.rows.find((r) => r.key === normPlace(name));

describe('تحليلات الأماكن', () => {
  let admin: TestUser, tl: TestUser, tl2: TestUser, eng1: TestUser, eng2: TestUser, eng3: TestUser, plain: TestUser;

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    tl = await createEngineer(admin.token, 'tl@test.com');
    tl2 = await createEngineer(admin.token, 'tl2@test.com');
    eng1 = await createEngineer(admin.token, 'eng1@test.com');
    eng2 = await createEngineer(admin.token, 'eng2@test.com');
    eng3 = await createEngineer(admin.token, 'eng3@test.com');
    plain = await createEngineer(admin.token, 'plain@test.com');

    await patchUser(admin.token, tl.id, { grade: 'team leader' });
    await patchUser(admin.token, tl2.id, { grade: 'team leader' });
    await patchUser(admin.token, eng1.id, { approverTlId: tl.id });
    await patchUser(admin.token, eng2.id, { approverTlId: tl.id });
    await patchUser(admin.token, eng3.id, { approverTlId: tl2.id }); // فريق تاني — لازم ما يظهرش لـ tl

    for (const u of [tl, tl2, eng1]) await setModules(admin.token, u.id, ['records', 'ir', 'analytics']);
    await setModules(admin.token, plain.id, ['records']); // من غير analytics عمدًا

    // نفس المكان بكتابتين (بألف همزة وبدونها) عند مهندسين مختلفين
    await addRecord(eng1.token, { date: '2026-08-10', place: 'الدور الأرضي', contractor: 'م1', price: 100, discount: 10 });
    await addRecord(eng2.token, { date: '2026-08-11', place: 'الدور الارضي', contractor: 'م2', price: 200 });
    await addRecord(eng3.token, { date: '2026-08-12', place: 'الدور الأرضي', contractor: 'م3', price: 1000 });
    await addRecord(eng1.token, { date: '2026-09-01', place: 'السطح', contractor: 'م1', price: 50 });

    await request(app).post('/api/ir-records').set(auth(eng1.token)).send({
      date: '2026-08-10', item: 'قواعد', place: 'الدور الأرضي', inspector: 'الاستشاري', status: 'A',
    });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('توحيد كتابة اسم المكان', () => {
    expect(normPlace('الدور الأرضي')).toBe(normPlace('الدور  الارضي'));
    expect(normPlace('  السطح ')).toBe(normPlace('السّطح'));
    expect(normPlace('الدور الأرضي')).not.toBe(normPlace('السطح'));
  });

  it('حساب من غير وحدة analytics بيتمنع', async () => {
    const res = await request(app).get('/api/analytics/places').set(auth(plain.token));
    expect(res.status).toBe(403);
  });

  it('الأدمن بيشوف كل الحسابات، والكتابتين بيتجمعوا في صف واحد', async () => {
    const res = await request(app).get('/api/analytics/places').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.level).toBe('all');
    expect(placesOf(res.body)).toHaveLength(2); // الدور الأرضي + السطح

    const ard = rowOf(res.body, 'الدور الأرضي')!;
    expect(ard.total).toBe(1290); // 90 + 200 + 1000
    expect(ard.gross).toBe(1300);
    expect(ard.discount).toBe(10);
    expect(ard.records).toBe(3);
    expect(ard.engineers).toBe(3);
    expect(ard.contractors).toBe(3);
    expect(ard.days).toBe(3);
    expect(ard.lastDate).toBe('2026-08-12');
    expect(ard.variants).toHaveLength(2); // كتابتين مختلفتين — تنبيه للأدمن
    expect(ard.ir).toMatchObject({ total: 1, a: 1 });

    expect(res.body.data.totals.total).toBe(1340); // 1290 + 50
    expect(res.body.data.totals.places).toBe(2);
  });

  it('مدير الفريق بيشوف مهندسينه بس', async () => {
    const res = await request(app).get('/api/analytics/places').set(auth(tl.token));
    expect(res.status).toBe(200);
    expect(res.body.level).toBe('team');
    const ard = rowOf(res.body, 'الدور الأرضي')!;
    expect(ard.total).toBe(290); // كشف eng3 (1000) بتاع فريق tl2 — مش هنا
    expect(ard.engineers).toBe(2);
  });

  it('مهندس عادي عنده الوحدة بيشوف سجلاته هو بس', async () => {
    const res = await request(app).get('/api/analytics/places').set(auth(eng1.token));
    expect(res.status).toBe(200);
    expect(res.body.level).toBe('self');
    expect(rowOf(res.body, 'الدور الأرضي')!.total).toBe(90);
    expect(res.body.data.totals.total).toBe(140); // 90 + 50
  });

  it('فلترة بمهندس بره النطاق بترجع فاضي (مش تسريب)', async () => {
    const res = await request(app).get(`/api/analytics/places?userId=${eng3.id}`).set(auth(tl.token));
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toHaveLength(0);
    expect(res.body.data.totals.total).toBe(0);
  });

  it('فلتر الفترة بيقص السجلات اللي بره المدى', async () => {
    const res = await request(app).get('/api/analytics/places?from=2026-09-01&to=2026-09-30').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(placesOf(res.body)).toEqual(['السطح']);
    expect(res.body.data.totals.total).toBe(50);
  });

  it('الاتجاه الزمني بيتجمّع في فترات', async () => {
    const res = await request(app).get('/api/analytics/trend?bucket=month').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { bucket: string }) => p.bucket)).toEqual(['2026-08', '2026-09']);
    expect(res.body.data[0].total).toBe(1290);
    expect(res.body.data[1].total).toBe(50);
  });

  it('الاتجاه الزمني لمكان واحد', async () => {
    const res = await request(app).get('/api/analytics/trend?bucket=month&place=' + encodeURIComponent('الدور الارضي')).set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1); // الكتابتين مكان واحد
    expect(res.body.data[0].total).toBe(1290);
  });

  it('نطاق الرؤية بيرجع قائمة المهندسين للفلاتر', async () => {
    const res = await request(app).get('/api/analytics/scope').set(auth(tl.token));
    expect(res.status).toBe(200);
    expect(res.body.data.level).toBe('team');
    const emails = res.body.data.engineers.map((e: { email: string }) => e.email).sort();
    expect(emails).toEqual(['eng1@test.com', 'eng2@test.com', 'tl@test.com']);
  });
});
