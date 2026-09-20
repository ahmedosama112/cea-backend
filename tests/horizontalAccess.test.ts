// اختبار صلاحيات أفقية (IDOR) — مهندسان في نفس المستوى بالظبط.
// كل محاولة من "أ" للوصول لبيانات "ب" لازم ترجع 4xx — والقوايم لازم ماتحتويش صفوف ب.
// الاختبارات العادية بتثبت إن الوظيفة شغالة بحساب واحد؛ دي بتثبت إن الوصول **بيفشل**.
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';

const MODS = ['records', 'submissions', 'approvals', 'analytics', 'labor_analytics', 'rent_requests', 'inventory', 'ir', 'todo', 'site_daily', 'site_exec', 'equipment'];
const attempts: Array<{ what: string; label: string; status: number; leaked: boolean }> = [];

async function tryAccess(what: string, method: 'get' | 'put' | 'delete' | 'post', path: string, token: string, body?: unknown) {
  const agent = request(app);
  let req;
  if (method === 'get') req = agent.get(path);
  else if (method === 'put') req = agent.put(path);
  else if (method === 'delete') req = agent.delete(path);
  else req = agent.post(path);
  req = req.set(auth(token));
  const res = body !== undefined ? await req.send(body as object) : await req;
  const leaked = res.status >= 200 && res.status < 300;
  attempts.push({ what, label: `${method.toUpperCase()} ${path}`, status: res.status, leaked });
  return res;
}

describe('صلاحيات أفقية بين مهندسين', () => {
  let admin: TestUser;
  let a: TestUser;
  let b: TestUser;
  const d: Record<string, string> = {};

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    a = await createEngineer(admin.token, 'eng-a@test.com');
    b = await createEngineer(admin.token, 'eng-b@test.com');
    for (const u of [a, b]) {
      await request(app).put(`/api/admin/users/${u.id}/settings`).set(auth(admin.token)).send({ enabledModules: MODS });
    }
    // المقاولون والأماكن بيانات مرجعية بيزرعها الأدمن في حساب المهندس (writeRoles: ADMIN)
    const c = await request(app).post(`/api/admin/users/${b.id}/contractors`).set(auth(admin.token)).send({ name: 'مقاول ب' });
    d.contractorId = String(c.body.data?.id ?? '');
    const p = await request(app).post(`/api/admin/users/${b.id}/places`).set(auth(admin.token)).send({ name: 'مكان ب' });
    d.placeId = String(p.body.data?.id ?? '');
    const rec = await request(app).post('/api/records').set(auth(b.token)).send({
      day: 'الاثنين', date: '2026-08-17', contractor: 'مقاول ب', spec: 'شغل ب',
      qty: 3, qtyType: 'يومية', price: 500, place: 'مكان ب',
    });
    d.recordId = rec.body.data?.id;
    const t = await request(app).post('/api/todos').set(auth(b.token)).send({ date: '2026-08-17', notes: 'مهمة ب', priority: 'عادي' });
    d.todoId = String(t.body.data?.id ?? '');
    // ملف مرفوع باسم ب — الوصول لمحتواه من أ هو أخطر تسريب (صور/توقيعات)
    const f = await request(app).post('/api/files').set(auth(b.token))
      .attach('file', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0x20)]), { filename: 'b.png', contentType: 'image/png' });
    d.fileId = String(f.body.data?.id ?? '');
    const rent = await request(app).post('/api/rent-requests').set(auth(b.token)).send({
      contractorId: d.contractorId, placeId: d.placeId, resourceType: 'LABOR',
      day: 'الاثنين', date: '2026-08-17', qty: 2, price: 300, statementOfWork: 'بيان ب',
    });
    d.rentId = rent.body.data?.id;
  });

  afterAll(async () => {
    const leaks = attempts.filter((x) => x.leaked);
    console.log('\n══════ تقرير الصلاحيات الأفقية ══════');
    for (const x of attempts) console.log(`${x.leaked ? '🔴 تسريب' : '✅ محجوب'}  ${x.status}  ${x.label}  — ${x.what}`);
    console.log(`\nالمحاولات: ${attempts.length} | محجوبة: ${attempts.length - leaks.length} | تسريبات: ${leaks.length}\n`);
    await prisma.$disconnect();
  });

  it('بيانات ب اتجهزت', () => {
    expect(d.recordId, 'سركي ب').toBeTruthy();
    expect(d.rentId, 'طلب إيجار ب').toBeTruthy();
    expect(d.contractorId, 'مقاول ب').toBeTruthy();
    expect(d.todoId, 'مهمة ب').toBeTruthy();
  });

  it('قراءة سركي ب', async () => {
    expect((await tryAccess('سركي ب', 'get', `/api/records/${d.recordId}`, a.token)).status).toBeGreaterThanOrEqual(400);
  });
  it('تعديل سركي ب', async () => {
    expect((await tryAccess('تعديل سركي ب', 'put', `/api/records/${d.recordId}`, a.token, { price: 1 })).status).toBeGreaterThanOrEqual(400);
  });
  it('حذف سركي ب', async () => {
    expect((await tryAccess('حذف سركي ب', 'delete', `/api/records/${d.recordId}`, a.token)).status).toBeGreaterThanOrEqual(400);
  });
  it('قائمة سراكي أ مافيهاش سراكي ب', async () => {
    const r = await request(app).get('/api/records').set(auth(a.token));
    const rows = (r.body.data?.rows ?? r.body.data ?? []) as Array<{ id: string }>;
    const ids = rows.map((x) => x.id);
    attempts.push({ what: 'قائمة السراكي', label: 'GET /api/records', status: r.status, leaked: ids.includes(d.recordId) });
    expect(ids).not.toContain(d.recordId);
  });
  it('قراءة طلب إيجار ب', async () => {
    expect((await tryAccess('طلب إيجار ب', 'get', `/api/rent-requests/${d.rentId}`, a.token)).status).toBeGreaterThanOrEqual(400);
  });
  it('اعتماد طلب إيجار ب', async () => {
    expect((await tryAccess('اعتماد طلب ب', 'post', `/api/rent-requests/${d.rentId}/decide`, a.token, { decision: 'APPROVED' })).status).toBeGreaterThanOrEqual(400);
  });
  it('قراءة مقاول ب', async () => {
    expect((await tryAccess('مقاول ب', 'get', `/api/contractors/${d.contractorId}`, a.token)).status).toBeGreaterThanOrEqual(400);
  });
  it('تعديل مقاول ب', async () => {
    expect((await tryAccess('تعديل مقاول ب', 'put', `/api/contractors/${d.contractorId}`, a.token, { name: 'مخطوف' })).status).toBeGreaterThanOrEqual(400);
  });
  it('حذف مكان ب', async () => {
    expect((await tryAccess('حذف مكان ب', 'delete', `/api/places/${d.placeId}`, a.token)).status).toBeGreaterThanOrEqual(400);
  });
  it('قراءة مهمة ب', async () => {
    expect((await tryAccess('مهمة ب', 'get', `/api/todos/${d.todoId}`, a.token)).status).toBeGreaterThanOrEqual(400);
  });
  it('قراءة بيانات ملف ب', async () => {
    if (!d.fileId) return;
    expect((await tryAccess('بيانات ملف ب', 'get', `/api/files/${d.fileId}`, a.token)).status).toBeGreaterThanOrEqual(400);
  });
  it('تنزيل محتوى ملف ب', async () => {
    if (!d.fileId) return;
    expect((await tryAccess('محتوى ملف ب', 'get', `/api/files/${d.fileId}/content`, a.token)).status).toBeGreaterThanOrEqual(400);
  });
  it('حذف ملف ب', async () => {
    if (!d.fileId) return;
    expect((await tryAccess('حذف ملف ب', 'delete', `/api/files/${d.fileId}`, a.token)).status).toBeGreaterThanOrEqual(400);
  });
  it('قائمة مقاولين أ مافيهاش مقاول ب', async () => {
    const r = await request(app).get('/api/contractors').set(auth(a.token));
    const rows = (r.body.data?.rows ?? r.body.data ?? []) as Array<{ id: string }>;
    attempts.push({ what: 'قائمة المقاولين', label: 'GET /api/contractors', status: r.status, leaked: rows.some((x) => String(x.id) === d.contractorId) });
    expect(rows.some((x) => String(x.id) === d.contractorId)).toBe(false);
  });
  it('قائمة طلبات الإيجار عند أ مافيهاش طلب ب', async () => {
    const r = await request(app).get('/api/rent-requests').set(auth(a.token));
    const rows = (r.body.data ?? []) as Array<{ id: string }>;
    attempts.push({ what: 'قائمة طلبات الإيجار', label: 'GET /api/rent-requests', status: r.status, leaked: rows.some((x) => String(x.id) === d.rentId) });
    expect(rows.some((x) => String(x.id) === d.rentId)).toBe(false);
  });
  it('إعدادات حساب ب عبر الأدمن', async () => {
    expect((await tryAccess('إعدادات ب', 'put', `/api/admin/users/${b.id}/settings`, a.token, { enabledModules: ['records'] })).status).toBeGreaterThanOrEqual(400);
  });
  it('ترقية نفسه لمدير مشروع', async () => {
    expect((await tryAccess('ترقية نفسه', 'put', `/api/admin/users/${a.id}`, a.token, { grade: 'project manager' })).status).toBeGreaterThanOrEqual(400);
  });
  it('قائمة كل الحسابات', async () => {
    expect((await tryAccess('قائمة الحسابات', 'get', '/api/admin/users', a.token)).status).toBeGreaterThanOrEqual(400);
  });
});
