import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';

// سجل نشاط الحسابات — الأدمن بيشوفه في كارت الحساب لتشخيص مشاكل الدخول/المزامنة
describe('سجل النشاط', () => {
  let admin: TestUser, eng: TestUser;

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    eng = await createEngineer(admin.token, 'act@test.com');
  });
  afterAll(async () => { await prisma.$disconnect(); });

  const wait = () => new Promise((r) => setTimeout(r, 400)); // الكتابة fire-and-forget

  it('بيسجّل دخول ناجح ودخول فاشل بالإيميل', async () => {
    await request(app).post('/api/auth/login').send({ email: 'act@test.com', password: 'password123' });
    await request(app).post('/api/auth/login').send({ email: 'act@test.com', password: 'ghalat-kheales' });
    await wait();
    const rows = (await request(app).get(`/api/admin/activity?userId=${eng.id}`).set(auth(admin.token))).body.data;
    expect(rows.some((r: { event: string }) => r.event === 'LOGIN_OK')).toBe(true);
    // الفشل بيتسجل بالإيميل (من غير userId) — بنجيبه بفلتر الإيميل
    const byEmail = (await request(app).get('/api/admin/activity?email=act@test.com').set(auth(admin.token))).body.data;
    expect(byEmail.some((r: { event: string }) => r.event === 'LOGIN_FAIL')).toBe(true);
  });

  it('بيسجّل المزامنة وأي خطأ رجع للجهاز (مع الحالة والمسار)', async () => {
    await request(app).post('/api/account/sync-stats').set(auth(eng.token)).send({ localRecords: 7, unsynced: 2 });
    // حساب معتمد بس (زي مدير المشروع): وحدة السراكي مش مفعّلة → 403 — ده بالظبط اللي كان بيحصل
    await request(app).put(`/api/admin/users/${eng.id}/settings`).set(auth(admin.token)).send({ enabledModules: ['approvals'] });
    const denied = await request(app).get('/api/records?limit=1').set(auth(eng.token));
    expect(denied.status).toBe(403);
    await wait();
    const rows = (await request(app).get(`/api/admin/activity?userId=${eng.id}`).set(auth(admin.token))).body.data;
    const sync = rows.find((r: { event: string }) => r.event === 'SYNC');
    expect(sync.detail).toContain('7');
    const err = rows.find((r: { event: string }) => r.event === 'API_ERR');
    expect(err.status).toBe(403);
    expect(err.path).toBe('/api/records');
  });

  it('ملخص كل الحسابات: بيرجّع كل حساب حتى لو مالوش نشاط، بعدادات وأكثر خطأ متكرر', async () => {
    const res = await request(app).get('/api/admin/activity/summary?days=7').set(auth(admin.token));
    expect(res.status).toBe(200);
    // الحسابين الاتنين موجودين (الأدمن مالوش نشاط يُذكر — ولازم يظهر برضو)
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    const row = res.body.data.find((r: { email: string }) => r.email === 'act@test.com');
    expect(row.loginOk).toBeGreaterThanOrEqual(1);
    expect(row.loginFail).toBeGreaterThanOrEqual(1);
    expect(row.sync).toBeGreaterThanOrEqual(1);
    expect(row.errors).toBeGreaterThanOrEqual(1);
    expect(row.errTop.status).toBe(403);
    expect(row.errTop.path).toBe('/api/records');
    // الحساب بقى معتمد بس (بلا وحدة السراكي) — الواجهة بتترجم 403 لـ"طبيعي" بناءً على ده
    expect(row.hasRecords).toBe(false);
    const adminRow = res.body.data.find((r: { email: string }) => r.email.includes('admin'));
    expect(adminRow).toBeTruthy();
    expect(adminRow.errTop).toBeNull();
  });

  it('خطأ التحقق (400) بيتسجل بالحقل والسبب — ده سبب "سجل لسه ما اترفعش" الأشهر', async () => {
    await request(app).put(`/api/admin/users/${eng.id}/settings`).set(auth(admin.token)).send({ enabledModules: ['records'] });
    const bad = await request(app).post('/api/records').set(auth(eng.token))
      .send({ day: 'السبت', date: '2026-09-05', contractor: 'مقاول', qty: 0, price: 100 }); // qty لازم > 0
    expect(bad.status).toBe(400);
    await wait();
    const rows = (await request(app).get(`/api/admin/activity?userId=${eng.id}`).set(auth(admin.token))).body.data;
    const err = rows.find((r: { event: string; path: string }) => r.event === 'API_ERR' && r.path === '/api/records');
    expect(err.status).toBe(400);
    expect(err.detail).toContain('qty');
  });

  it('السجل للأدمن فقط', async () => {
    const denied = await request(app).get('/api/admin/activity').set(auth(eng.token));
    expect(denied.status).toBe(403);
    const denied2 = await request(app).get('/api/admin/activity/summary').set(auth(eng.token));
    expect(denied2.status).toBe(403);
  });
});
