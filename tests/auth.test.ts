import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, auth } from './helpers';

describe('Auth', () => {
  beforeAll(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  let adminToken: string;
  let adminRefresh: string;

  it('أول مستخدم في نظام فاضي يتسجل بدون توكن ويصبح ADMIN', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'admin@test.com', password: 'password123' });
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('ADMIN');
    adminToken = res.body.data.accessToken;
    adminRefresh = res.body.data.refreshToken;
  });

  it('التسجيل بدون توكن يُرفض بعد وجود مستخدمين', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'x@test.com', password: 'password123' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('الأدمن ينشئ مهندسًا، والمهندس لا ينشئ حسابات', async () => {
    const eng = await request(app)
      .post('/api/auth/register')
      .set(auth(adminToken))
      .send({ email: 'eng@test.com', password: 'password123' });
    expect(eng.status).toBe(201);
    expect(eng.body.data.user.role).toBe('ENGINEER');

    const attempt = await request(app)
      .post('/api/auth/register')
      .set(auth(eng.body.data.accessToken))
      .send({ email: 'y@test.com', password: 'password123' });
    expect(attempt.status).toBe(403);
  });

  it('login بكلمة سر غلط يرجع 401 برسالة موحدة (لا يكشف وجود الإيميل)', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'admin@test.com', password: 'wrong-pass' });
    expect(res.status).toBe(401);
    const ghost = await request(app).post('/api/auth/login').send({ email: 'ghost@test.com', password: 'wrong-pass' });
    expect(ghost.status).toBe(401);
    expect(ghost.body.message).toBe(res.body.message);
  });

  it('login صحيح يرجع توكنات و /me يتعرف على المستخدم', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'admin@test.com', password: 'password123' });
    expect(res.status).toBe(200);
    const me = await request(app).get('/api/auth/me').set(auth(res.body.data.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe('admin@test.com');
  });

  it('التجديد بدون تدوير: نفس التوكن يفضل صالح، وأي عدد تجديدات متزامنة تنجح', async () => {
    // التجديد بيرجّع نفس refresh token (مش بيدوّره) — يمنع سباقات تعدد الأجهزة/التبويبات
    const r1 = await request(app).post('/api/auth/refresh').send({ refreshToken: adminRefresh });
    expect(r1.status).toBe(200);
    expect(r1.body.data.refreshToken).toBe(adminRefresh);
    expect(r1.body.data.accessToken).toBeTruthy();

    // تجديدات متزامنة بنفس التوكن — كلها تنجح، مفيش إلغاء جماعي
    const many = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post('/api/auth/refresh').send({ refreshToken: adminRefresh })),
    );
    many.forEach((r) => {
      expect(r.status).toBe(200);
      expect(r.body.data.refreshToken).toBe(adminRefresh);
    });

    // بعد logout التوكن يُلغى فورًا → التجديد يفشل
    await request(app).post('/api/auth/logout').send({ refreshToken: adminRefresh });
    const afterLogout = await request(app).post('/api/auth/refresh').send({ refreshToken: adminRefresh });
    expect(afterLogout.status).toBe(401);
  });

  it('تغيير كلمة السر يبطل كل الجلسات القائمة', async () => {
    const login = await request(app).post('/api/auth/login').send({ email: 'admin@test.com', password: 'password123' });
    const t = login.body.data.accessToken;
    const rt = login.body.data.refreshToken;

    const change = await request(app)
      .post('/api/auth/change-password')
      .set(auth(t))
      .send({ currentPassword: 'password123', newPassword: 'newpassword456' });
    expect(change.status).toBe(200);

    const refreshAfter = await request(app).post('/api/auth/refresh').send({ refreshToken: rt });
    expect(refreshAfter.status).toBe(401);

    const reLogin = await request(app).post('/api/auth/login').send({ email: 'admin@test.com', password: 'newpassword456' });
    expect(reLogin.status).toBe(200);
  });

  it('validation: إيميل بصيغة غلط أو كلمة سر قصيرة = 400', async () => {
    const bad1 = await request(app).post('/api/auth/login').send({ email: 'not-an-email', password: 'x' });
    expect(bad1.status).toBe(400);
    expect(bad1.body.code).toBe('VALIDATION_ERROR');
  });

  it('مسار محمي بدون توكن = 401', async () => {
    const res = await request(app).get('/api/records');
    expect(res.status).toBe(401);
  });
});
