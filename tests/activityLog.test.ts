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

  it('السجل للأدمن فقط', async () => {
    const denied = await request(app).get('/api/admin/activity').set(auth(eng.token));
    expect(denied.status).toBe(403);
  });
});
