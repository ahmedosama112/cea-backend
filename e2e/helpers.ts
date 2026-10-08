// أدوات مشتركة لاختبارات e2e — كل الطلبات HTTP حقيقية للسيرفر اللي scripts/run-e2e.js مشغّله
const APP_URL = process.env.APP_URL;
if (!APP_URL) throw new Error('APP_URL غير محدد — شغّل الاختبارات بـ "npm run test:e2e" مش "npx e2e run" مباشرة');

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export async function api<T = any>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(new URL(path, APP_URL), {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

export interface Session {
  token: string;
  refreshToken: string;
  id: string;
  email: string;
}

export async function login(email: string, password: string): Promise<Session> {
  const res = await api('POST', '/api/auth/login', { body: { email, password } });
  if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  const d = res.body.data;
  return { token: d.accessToken, refreshToken: d.refreshToken, id: String(d.user.id), email };
}

// الأدمن بيتسجل مرة واحدة في scripts/run-e2e.js (أول مستخدم = ADMIN)
export function loginAdmin(): Promise<Session> {
  return login(process.env.E2E_ADMIN_EMAIL!, process.env.E2E_ADMIN_PASSWORD!);
}

// إيميل فريد لكل تشغيل عشان الملفات ما تتخانقش على نفس الحساب
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
}

export async function createEngineer(adminToken: string, prefix = 'eng', modules?: string[]): Promise<Session> {
  const email = uniqueEmail(prefix);
  const password = 'password123';
  const res = await api('POST', '/api/auth/register', { token: adminToken, body: { email, password } });
  if (res.status !== 201) throw new Error(`createEngineer failed: ${res.status} ${JSON.stringify(res.body)}`);
  const d = res.body.data;
  if (modules) {
    const s = await api('PUT', `/api/admin/users/${d.user.id}/settings`, { token: adminToken, body: { enabledModules: modules } });
    if (s.status !== 200) throw new Error(`enable modules failed: ${s.status} ${JSON.stringify(s.body)}`);
  }
  return { token: d.accessToken, refreshToken: d.refreshToken, id: String(d.user.id), email };
}
