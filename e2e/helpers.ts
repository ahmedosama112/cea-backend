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

// رفع multipart (ملف + حقول) — نفس اللي الواجهة بتبعته
export async function upload<T = any>(
  method: string,
  path: string,
  opts: { token: string; file?: { name: string; type: string; bytes: Uint8Array }; fields?: Record<string, string> },
): Promise<ApiResponse<T>> {
  const form = new FormData();
  for (const [k, v] of Object.entries(opts.fields ?? {})) form.append(k, v);
  if (opts.file) form.append('file', new Blob([opts.file.bytes], { type: opts.file.type }), opts.file.name);
  const res = await fetch(new URL(path, APP_URL), { method, headers: { authorization: `Bearer ${opts.token}` }, body: form });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

// تنزيل ملف — بيرجّع الـ Response نفسه (المحتوى مش JSON)
export function download(path: string, token: string): Promise<Response> {
  return fetch(new URL(path, APP_URL), { headers: { authorization: `Bearer ${token}` } });
}

// بايتات بأقل توقيع يقبله السيرفر (بيفحص أول البايتات مش الامتداد)
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
export const XLSX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x74, 0x65, 0x73, 0x74, 0x2d, 0x65, 0x32, 0x65]);

export async function setModules(adminToken: string, userId: string, modules: string[]): Promise<void> {
  const s = await api('PUT', `/api/admin/users/${userId}/settings`, { token: adminToken, body: { enabledModules: modules } });
  if (s.status !== 200) throw new Error(`enable modules failed: ${s.status} ${JSON.stringify(s.body)}`);
}

// تعديل حساب من الأدمن (الدرجة، المعتمدين المسندين، ...)
export async function patchUser(adminToken: string, userId: string, body: Record<string, unknown>): Promise<void> {
  const r = await api('PATCH', `/api/admin/users/${userId}`, { token: adminToken, body });
  if (r.status !== 200) throw new Error(`patch user failed: ${r.status} ${JSON.stringify(r.body)}`);
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
  if (modules) await setModules(adminToken, String(d.user.id), modules);
  return { token: d.accessToken, refreshToken: d.refreshToken, id: String(d.user.id), email };
}
