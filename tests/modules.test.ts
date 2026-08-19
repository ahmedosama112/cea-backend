import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';

describe('الوحدات لكل حساب (feature flags)', () => {
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

  it('الافتراضي لمهندس جديد: السراكي والمهام والملخص فقط — IR مقفول', async () => {
    const s = await request(app).get('/api/account/settings').set(auth(eng.token));
    expect(s.body.data.enabledModules).toEqual(['records', 'todo', 'summary']);

    const ir = await request(app).get('/api/ir-records').set(auth(eng.token));
    expect(ir.status).toBe(403);

    const recs = await request(app).get('/api/records').set(auth(eng.token));
    expect(recs.status).toBe(200);
  });

  it('الأدمن يشوف كل الوحدات دايمًا ويوصل لأي مسار', async () => {
    const s = await request(app).get('/api/account/settings').set(auth(admin.token));
    expect(s.body.data.enabledModules).toContain('ir');
    const ir = await request(app).get('/api/ir-records').set(auth(admin.token));
    expect(ir.status).toBe(200);
  });

  it('الأدمن يفعّل IR لمهندس → يقدر يستخدمه؛ ويقفله → يتمنع فورًا', async () => {
    const on = await request(app)
      .put(`/api/admin/users/${eng.id}/settings`)
      .set(auth(admin.token))
      .send({ enabledModules: ['records', 'ir'] });
    expect(on.status).toBe(200);
    expect(on.body.data.enabledModules).toEqual(['records', 'ir']);

    const irOk = await request(app).get('/api/ir-records').set(auth(eng.token));
    expect(irOk.status).toBe(200);
    // المهام اتقفلت في نفس التحديث
    const todos = await request(app).get('/api/todos').set(auth(eng.token));
    expect(todos.status).toBe(403);

    await request(app).put(`/api/admin/users/${eng.id}/settings`).set(auth(admin.token)).send({ enabledModules: ['records'] });
    const irOff = await request(app).get('/api/ir-records').set(auth(eng.token));
    expect(irOff.status).toBe(403);
  });

  it('المهندس لا يقدر يفعّل وحدات لنفسه', async () => {
    const r = await request(app).put('/api/account/settings').set(auth(eng.token)).send({ enabledModules: ['ir'] });
    expect(r.status).toBe(403);
  });

  it('قيم غير معروفة تُرفض، وقائمة الوحدات متاحة للأدمن', async () => {
    const bad = await request(app).put(`/api/admin/users/${eng.id}/settings`).set(auth(admin.token)).send({ enabledModules: ['hack'] });
    expect(bad.status).toBe(400);
    const list = await request(app).get('/api/admin/modules').set(auth(admin.token));
    expect(list.body.data.modules.map((m: { key: string }) => m.key)).toContain('site_daily');
    expect(list.body.data.features.map((f: { key: string }) => f.key)).toContain('set_danger');
  });

  it('الكروت (features): الأدمن يخفي كارت لمهندس، والمهندس يقرأها ولا يعدلها', async () => {
    const def = await request(app).get('/api/account/settings').set(auth(eng.token));
    expect(def.body.data.enabledFeatures).toContain('set_contractors');
    expect(def.body.data.enabledFeatures).not.toContain('set_danger'); // مخفي افتراضيًا

    const set = await request(app).put(`/api/admin/users/${eng.id}/settings`).set(auth(admin.token))
      .send({ enabledFeatures: ['set_account', 'home_recent'] });
    expect(set.status).toBe(200);
    expect(set.body.data.enabledFeatures).toEqual(['home_recent', 'set_account']); // بترتيب القائمة الأصلية

    const engSelf = await request(app).put('/api/account/settings').set(auth(eng.token)).send({ enabledFeatures: ['set_danger'] });
    expect(engSelf.status).toBe(403);

    const bad = await request(app).put(`/api/admin/users/${eng.id}/settings`).set(auth(admin.token)).send({ enabledFeatures: ['nope'] });
    expect(bad.status).toBe(400);
  });

  it('الأدمن ينشئ مهندسًا بوحدات محددة من الأول + يعيد تعيين كلمة سره', async () => {
    const created = await request(app)
      .post('/api/admin/users')
      .set(auth(admin.token))
      .send({ email: 'eng2@test.com', password: 'password123', enabledModules: ['records', 'summary'] });
    expect(created.status).toBe(201);
    const login = await request(app).post('/api/auth/login').send({ email: 'eng2@test.com', password: 'password123' });
    const s = await request(app).get('/api/account/settings').set(auth(login.body.data.accessToken));
    expect(s.body.data.enabledModules).toEqual(['records', 'summary']);

    const reset = await request(app).post(`/api/admin/users/${created.body.data.id}/reset-password`).set(auth(admin.token)).send({ newPassword: 'newpass456' });
    expect(reset.status).toBe(200);
    const oldLogin = await request(app).post('/api/auth/login').send({ email: 'eng2@test.com', password: 'password123' });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app).post('/api/auth/login').send({ email: 'eng2@test.com', password: 'newpass456' });
    expect(newLogin.status).toBe(200);
  });
});
