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
    expect(s.body.data.enabledModules).toEqual(['records', 'submissions', 'todo', 'summary']);

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

  it('المسمى الوظيفي: يُحدد عند الإنشاء ويُعدَّل بعدها، ويظهر في /me', async () => {
    const c = await request(app).post('/api/admin/users').set(auth(admin.token)).send({ email: 'titled@test.com', password: 'password123', title: 'مهندس مكتب فني' });
    expect(c.status).toBe(201);
    expect(c.body.data.title).toBe('مهندس مكتب فني');
    const upd = await request(app).patch(`/api/admin/users/${c.body.data.id}`).set(auth(admin.token)).send({ title: 'مساح' });
    expect(upd.body.data.title).toBe('مساح');
    const login = await request(app).post('/api/auth/login').send({ email: 'titled@test.com', password: 'password123' });
    const me = await request(app).get('/api/auth/me').set(auth(login.body.data.accessToken));
    expect(me.body.data.title).toBe('مساح');
    // الأدمن لا ينزّل نفسه
    const self = await request(app).patch(`/api/admin/users/${admin.id}`).set(auth(admin.token)).send({ role: 'ENGINEER' });
    expect(self.status).toBe(400);
  });

  it('حذف حساب: يرفض بدون إيميل مطابق، ويمسح كل بياناته cascade، ولا يحذف نفسه', async () => {
    const c = await request(app).post('/api/admin/users').set(auth(admin.token)).send({ email: 'todelete@test.com', password: 'password123' });
    const id = c.body.data.id;
    await request(app).post(`/api/admin/users/${id}/places`).set(auth(admin.token)).send({ name: 'مكان للحذف' });
    const sum = await request(app).get(`/api/admin/users/${id}/summary`).set(auth(admin.token));
    expect(sum.body.data.places).toBe(1);
    const wrong = await request(app).delete(`/api/admin/users/${id}`).set(auth(admin.token)).send({ confirmEmail: 'other@test.com' });
    expect(wrong.status).toBe(400);
    const self = await request(app).delete(`/api/admin/users/${admin.id}`).set(auth(admin.token)).send({ confirmEmail: admin.email });
    expect(self.status).toBe(400);
    const ok = await request(app).delete(`/api/admin/users/${id}`).set(auth(admin.token)).send({ confirmEmail: 'todelete@test.com' });
    expect(ok.status).toBe(200);
    const gone = await prisma.user.findUnique({ where: { id: BigInt(id) } });
    expect(gone).toBeNull();
    const placesLeft = await prisma.place.count({ where: { userId: BigInt(id) } });
    expect(placesLeft).toBe(0);
  });

  it('الأدمن ينشئ أدمن تاني لو حدد role=ADMIN، والمهندس لا يقدر', async () => {
    const a2 = await request(app).post('/api/admin/users').set(auth(admin.token)).send({ email: 'admin2@test.com', password: 'password123', role: 'ADMIN' });
    expect(a2.status).toBe(201);
    expect(a2.body.data.role).toBe('ADMIN');
    const engTry = await request(app).post('/api/admin/users').set(auth(eng.token)).send({ email: 'x@test.com', password: 'password123', role: 'ADMIN' });
    expect(engTry.status).toBe(403);
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
