import { describe, test, expect } from 'e2e';
import { api, createEngineer, loginAdmin } from './helpers';

test('GET /health بيرد ok والقاعدة متصلة', async () => {
  const res = await api('GET', '/health');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, status: 'ok' });
});

describe('المصادقة', () => {
  test('login بباسورد غلط بيرجع 401 بالصيغة الموحدة', async () => {
    const res = await api('POST', '/api/auth/login', {
      body: { email: process.env.E2E_ADMIN_EMAIL, password: 'wrong-password' },
    });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  test('مدخلات ناقصة بترجع VALIDATION_ERROR', async () => {
    const res = await api('POST', '/api/auth/login', { body: { email: 'not-an-email' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('أي مسار محمي من غير توكن بيرجع 401', async () => {
    const res = await api('GET', '/api/auth/me');
    expect(res.status).toBe(401);
  });

  test('الأدمن بيعمل login و /me بترجّع دوره', async () => {
    const admin = await loginAdmin();
    const me = await api('GET', '/api/auth/me', { token: admin.token });
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe(process.env.E2E_ADMIN_EMAIL);
    expect(me.body.data.role).toBe('ADMIN');
  });

  test('المستخدم اللي الأدمن بيسجّله بيبقى ENGINEER', async () => {
    const admin = await loginAdmin();
    const eng = await createEngineer(admin.token);
    const me = await api('GET', '/api/auth/me', { token: eng.token });
    expect(me.status).toBe(200);
    expect(me.body.data.role).toBe('ENGINEER');
  });

  // التجديد من غير تدوير (auth.service.ts): access جديد ونفس الـ refresh — والـ logout بيبطله
  test('refresh بيدّي access token شغال، وبعد logout بيترفض', async () => {
    const admin = await loginAdmin();
    const refreshed = await api('POST', '/api/auth/refresh', { body: { refreshToken: admin.refreshToken } });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.refreshToken).toBe(admin.refreshToken);
    const me = await api('GET', '/api/auth/me', { token: refreshed.body.data.accessToken });
    expect(me.status).toBe(200);

    const out = await api('POST', '/api/auth/logout', { body: { refreshToken: admin.refreshToken } });
    expect(out.status).toBe(200);
    const afterLogout = await api('POST', '/api/auth/refresh', { body: { refreshToken: admin.refreshToken } });
    expect(afterLogout.status).toBe(401);
  });
});
