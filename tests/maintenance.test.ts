import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';
import { _resetMaintenanceCache } from '../src/services/maintenance';

describe('وضع الإيقاف (Service stopped)', () => {
  let admin: TestUser;
  let eng: TestUser;

  beforeAll(async () => {
    await resetDb();
    _resetMaintenanceCache();
    admin = await createAdmin();
    eng = await createEngineer(admin.token);
  });

  beforeEach(async () => {
    // كل اختبار بيبدأ والخدمة شغالة
    await request(app).put('/api/admin/maintenance').set(auth(admin.token)).send({ on: false });
  });

  it('مطفي افتراضيًا: /api/status بيقول شغال والمهندس بيشتغل عادي', async () => {
    const st = await request(app).get('/api/status');
    expect(st.status).toBe(200);
    expect(st.body.data).toEqual({ maintenance: false, message: '' });
    const me = await request(app).get('/api/auth/me').set(auth(eng.token));
    expect(me.status).toBe(200);
  });

  it('المهندس ما يقدرش يشغّل أو يطفي الوضع', async () => {
    const r = await request(app).put('/api/admin/maintenance').set(auth(eng.token)).send({ on: true });
    expect(r.status).toBe(403);
  });

  it('وهو شغال: المهندس بياخد 503 MAINTENANCE والأدمن شغال عادي', async () => {
    const on = await request(app).put('/api/admin/maintenance').set(auth(admin.token)).send({ on: true, message: 'صيانة لحد الساعة 5' });
    expect(on.status).toBe(200);
    expect(on.body.data.on).toBe(true);
    expect(on.body.data.since).toBeTruthy();

    const st = await request(app).get('/api/status');
    expect(st.body.data).toEqual({ maintenance: true, message: 'صيانة لحد الساعة 5' });

    const me = await request(app).get('/api/auth/me').set(auth(eng.token));
    expect(me.status).toBe(503);
    expect(me.body.code).toBe('MAINTENANCE');
    expect(me.body.message).toBe('صيانة لحد الساعة 5');

    const records = await request(app).get('/api/records').set(auth(eng.token));
    expect(records.status).toBe(503);

    const adminMe = await request(app).get('/api/auth/me').set(auth(admin.token));
    expect(adminMe.status).toBe(200);
    const adminUsers = await request(app).get('/api/admin/users').set(auth(admin.token));
    expect(adminUsers.status).toBe(200);
  });

  it('وهو شغال: دخول وتجديد المهندس مقفولين، والأدمن بيدخل عادي', async () => {
    await request(app).put('/api/admin/maintenance').set(auth(admin.token)).send({ on: true });

    const login = await request(app).post('/api/auth/login').send({ email: eng.email, password: 'password123' });
    expect(login.status).toBe(503);
    expect(login.body.code).toBe('MAINTENANCE');
    expect(login.body.data).toBeUndefined();

    // كلمة سر غلط بتفضل 401 — الوضع ما بيكشفش إن الحساب موجود
    const wrong = await request(app).post('/api/auth/login').send({ email: eng.email, password: 'nope-nope' });
    expect(wrong.status).toBe(401);

    const refresh = await request(app).post('/api/auth/refresh').send({ refreshToken: eng.refreshToken });
    expect(refresh.status).toBe(503);

    const adminLogin = await request(app).post('/api/auth/login').send({ email: admin.email, password: 'password123' });
    expect(adminLogin.status).toBe(200);
    expect(adminLogin.body.data.accessToken).toBeTruthy();
  });

  it('بعد ما الأدمن يطفيه المهندس بيرجع يشتغل فورًا', async () => {
    await request(app).put('/api/admin/maintenance').set(auth(admin.token)).send({ on: true });
    expect((await request(app).get('/api/auth/me').set(auth(eng.token))).status).toBe(503);

    const off = await request(app).put('/api/admin/maintenance').set(auth(admin.token)).send({ on: false });
    expect(off.body.data).toEqual({ on: false, message: '', since: null });
    expect((await request(app).get('/api/auth/me').set(auth(eng.token))).status).toBe(200);
    expect((await request(app).get('/api/status')).body.data.maintenance).toBe(false);
  });
});
