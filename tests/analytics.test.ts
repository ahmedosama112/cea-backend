import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';
import { normName } from '../src/services/analytics.service';

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
  body.data.rows.find((r) => r.key === normName(name));

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

    // قائمة المقاولين عند الأدمن = المعجم. "م3" مش فيها عمدًا (يمثّل اسم قديم في سجل قديم).
    await request(app).post('/api/contractors').set(auth(admin.token)).send({ name: 'م1', spec: 'نجارة', rate: 300, rateType: 'يومية' });
    await request(app).post('/api/contractors').set(auth(admin.token)).send({ name: 'م2', spec: 'حدادة' });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('توحيد كتابة اسم المكان', () => {
    expect(normName('الدور الأرضي')).toBe(normName('الدور  الارضي'));
    expect(normName('  السطح ')).toBe(normName('السّطح'));
    expect(normName('الدور الأرضي')).not.toBe(normName('السطح'));
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

  it('جدول المقاولين بيتجمّع عبر المهندسين، والاسم اللي مش في قائمة الأدمن بيتعلّم', async () => {
    const res = await request(app).get('/api/analytics/contractors').set(auth(admin.token));
    expect(res.status).toBe(200);
    const by = (n: string) => res.body.data.rows.find((r: { key: string }) => r.key === normName(n));

    const m1 = by('م1')!;
    expect(m1.inList).toBe(true);
    expect(m1.spec).toBe('نجارة');
    expect(m1.rate).toBe(300);
    expect(m1.rateType).toBe('يومية'); // مش 'DAILY' — الـ API بيتكلم عربي زي باقي المسارات
    expect(m1.total).toBe(140); // 90 (الدور الأرضي) + 50 (السطح)
    expect(m1.places).toBe(2);
    expect(m1.engineers).toBe(1);

    const m3 = by('م3')!;
    expect(m3.inList).toBe(false); // اسم في السجلات مش في قائمة الأدمن
    expect(m3.total).toBe(1000);

    expect(res.body.data.totals.contractors).toBe(3);
    expect(res.body.data.totals.unknown).toBe(1);
    expect(res.body.data.totals.total).toBe(1340);
  });

  it('جدول المقاولين بيحترم نطاق مدير الفريق', async () => {
    const res = await request(app).get('/api/analytics/contractors').set(auth(tl.token));
    expect(res.status).toBe(200);
    const keys = res.body.data.rows.map((r: { key: string }) => r.key);
    expect(keys).not.toContain(normName('م3')); // مقاول eng3 (فريق tl2)
    expect(res.body.data.totals.total).toBe(340); // eng1 (90+50) + eng2 (200)
  });

  it('الاتجاه الزمني لمقاول واحد', async () => {
    const res = await request(app).get('/api/analytics/trend?bucket=month&contractor=' + encodeURIComponent('م1')).set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { bucket: string }) => p.bucket)).toEqual(['2026-08', '2026-09']);
    expect(res.body.data[0].total).toBe(90);
    expect(res.body.data[1].total).toBe(50);
  });

  it('مصفوفة مقاول × مكان: خانة لكل ثنائي فيه شغل', async () => {
    const res = await request(app).get('/api/analytics/matrix').set(auth(admin.token));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.totals.pairs).toBe(4); // م1×الأرضي · م2×الأرضي · م3×الأرضي · م1×السطح
    expect(d.totals.total).toBe(1340);
    expect(d.totals.hiddenContractors).toBe(0);
    expect(d.totals.hiddenPlaces).toBe(0);
    expect(d.totals.hiddenTotal).toBe(0);

    const cell = (c: string, p: string) =>
      d.cells.find((x: { c: string; p: string }) => x.c === normName(c) && x.p === normName(p));
    // الكتابتين المختلفتين للمكان بيقعوا في نفس العمود
    expect(cell('م2', 'الدور الأرضي').total).toBe(200);
    expect(cell('م1', 'الدور الارضي').total).toBe(90);
    expect(cell('م1', 'السطح').total).toBe(50);
    expect(cell('م2', 'السطح')).toBeUndefined(); // ثنائي مفيهوش شغل = مفيش خانة

    expect(d.contractors[0].key).toBe(normName('م3')); // الأعلى منصرفًا (1000)
    expect(d.topPairs[0].total).toBe(1000);
  });

  it('المصفوفة بتقصّ على السقف وبتقول اللي اتشال', async () => {
    const res = await request(app).get('/api/analytics/matrix?limit=5&from=2026-08-01&to=2026-08-31').set(auth(admin.token));
    expect(res.status).toBe(200);
    // 3 مقاولين ومكان واحد في أغسطس — أقل من السقف، مفيش قص
    expect(res.body.data.totals.hiddenContractors).toBe(0);
    expect(res.body.data.totals.total).toBe(1290);

    const one = await request(app).get('/api/analytics/matrix?limit=5&userId=' + eng1.id).set(auth(admin.token));
    expect(one.body.data.totals.total).toBe(140); // النطاق والفلاتر بتتطبق زي باقي المسارات
  });

  it('نطاق الرؤية بيرجع قائمة المهندسين للفلاتر', async () => {
    const res = await request(app).get('/api/analytics/scope').set(auth(tl.token));
    expect(res.status).toBe(200);
    expect(res.body.data.level).toBe('team');
    const emails = res.body.data.engineers.map((e: { email: string }) => e.email).sort();
    expect(emails).toEqual(['eng1@test.com', 'eng2@test.com', 'tl@test.com']);
  });

  it('جدول المقاولين: اليوميات بتجمع الكمية للسجلات "يومية" بس', async () => {
    await request(app).post('/api/records').set(auth(eng1.token)).send({
      day: 'الاثنين', date: '2026-09-05', contractor: 'م4', place: 'السطح',
      qty: 2, qtyType: 'يومية', price: 100, discount: 0,
    });
    await request(app).post('/api/records').set(auth(eng1.token)).send({
      day: 'الاثنين', date: '2026-09-06', contractor: 'م4', place: 'السطح',
      qty: 3, qtyType: 'يومية', price: 100, discount: 0,
    });
    await request(app).post('/api/records').set(auth(eng1.token)).send({
      day: 'الاثنين', date: '2026-09-07', contractor: 'م4', place: 'السطح',
      qty: 8, qtyType: 'ساعة', price: 100, discount: 0,
    });

    const res = await request(app).get('/api/analytics/contractors?fresh=1').set(auth(admin.token));
    expect(res.status).toBe(200);
    const by = (n: string) => res.body.data.rows.find((r: { key: string }) => r.key === normName(n));

    const m4 = by('م4')!;
    expect(m4.dailyQty).toBe(5); // 2 + 3 — سجل الساعة (8) مش داخل في الحساب

    expect(res.body.data.totals.dailyQty).toBeGreaterThanOrEqual(5);
  });
});

describe('تحليلات "الإجمالي الفعلي"', () => {
  let admin: TestUser, eng: TestUser;

  async function seedFile(userId: string) {
    return prisma.file.create({
      data: { userId: BigInt(userId), fileName: 'k.xlsx', filePath: 'x/k.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileSize: 10 },
    });
  }
  async function seedSubmission(userId: string, body: Record<string, unknown>) {
    const file = await seedFile(userId);
    return prisma.submission.create({
      data: {
        userId: BigInt(userId), fileId: file.id, contractorName: 'مقاول', placeName: 'موقع',
        weekEnd: new Date('2026-08-07'), recordsCount: 1, kind: 'labor', reviewState: 'SENT',
        ...body,
      },
    });
  }

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    eng = await createEngineer(admin.token, 'eng@test.com');
    await setModules(admin.token, eng.id, ['records', 'analytics']);

    // معتمد (SENT)، approvedTotal موجود — بيفضّل على total
    await seedSubmission(eng.id, { weekStart: new Date('2026-08-01'), total: 100, approvedTotal: 90 });
    // معتمد (SENT)، approvedTotal فاضي (كشف قديم) — بيتحسب بـ total، وبيتعد ضمن estimated
    await seedSubmission(eng.id, { weekStart: new Date('2026-08-08'), total: 200, approvedTotal: null });
    // سركي معدات — مايتحسبش هنا (الإجمالي ساعات مش فلوس)
    await seedSubmission(eng.id, { weekStart: new Date('2026-09-01'), total: 50, approvedTotal: null, kind: 'equipment' });
    // لسه في سلسلة الاعتماد (مش SENT) — مايتحسبش
    await seedSubmission(eng.id, { weekStart: new Date('2026-08-15'), total: 10, approvedTotal: null, reviewState: 'IN_REVIEW' });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('بس الكشوف SENT بتتحسب', async () => {
    const res = await request(app).get('/api/analytics/approved-totals').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.totals.submissions).toBe(2); // مش الـ IN_REVIEW ومش المعدات
  });

  it('سركي المعدات مش داخل الحساب', async () => {
    const res = await request(app).get('/api/analytics/approved-totals?from=2026-09-01&to=2026-09-30').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.totals.submissions).toBe(0);
    expect(res.body.data.totals.total).toBe(0);
  });

  it('approvedTotal بيفضّل على total، وtotal بيتستخدم لو approvedTotal فاضي', async () => {
    const res = await request(app).get('/api/analytics/approved-totals?bucket=week').set(auth(admin.token));
    expect(res.status).toBe(200);
    const rows: Array<{ key: string; total: number }> = res.body.data.rows;
    const r1 = rows.find((r) => r.key === '2026-08-01')!;
    const r2 = rows.find((r) => r.key === '2026-08-08')!;
    expect(r1.total).toBe(90); // approvedTotal
    expect(r2.total).toBe(200); // total (approvedTotal فاضي)
  });

  it('estimated بيعد الكشوف اللي approvedTotal فيها فاضي', async () => {
    const res = await request(app).get('/api/analytics/approved-totals').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.totals.estimated).toBe(1);
  });

  it('التجميع الشهري بيضم كشفين في نفس الشهر في صف واحد', async () => {
    const res = await request(app).get('/api/analytics/approved-totals?bucket=month').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toHaveLength(1);
    const row = res.body.data.rows[0];
    expect(row.key).toBe('2026-08');
    expect(row.submissions).toBe(2);
    expect(row.total).toBe(290); // 90 + 200
    expect(row.estimated).toBe(1);
  });
});
