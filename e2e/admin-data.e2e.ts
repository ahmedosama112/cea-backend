import { describe, test, expect } from 'e2e';
import { api, createEngineer, loginAdmin, type Session } from './helpers';

// البيانات المرجعية (المقاولون والأماكن) بيديرها الأدمن، والمهندس بيقرا بس
describe('بيانات يديرها الأدمن', { serial: true }, () => {
  let admin: string;
  let eng: Session;
  const contractor = `مقاول e2e ${Date.now()}`;

  test('الأدمن يضيف مقاول، ونفس الاسم تاني = 409', async () => {
    admin = (await loginAdmin()).token;
    eng = await createEngineer(admin, 'data-eng');
    const created = await api('POST', '/api/contractors', { token: admin, body: { name: contractor, spec: 'نقاش', rate: 350, rateType: 'ساعة' } });
    expect(created.status).toBe(201);
    expect(created.body.data.rateType).toBe('ساعة');
    const dup = await api('POST', '/api/contractors', { token: admin, body: { name: contractor } });
    expect(dup.status).toBe(409);
  });

  test('المهندس ما يكتبش في المقاولين ولا الأماكن', async () => {
    expect((await api('POST', '/api/contractors', { token: eng.token, body: { name: 'ممنوع' } })).status).toBe(403);
    expect((await api('POST', '/api/places', { token: eng.token, body: { name: 'ممنوع' } })).status).toBe(403);
  });

  test('الأدمن يزرع مقاول ومكان في حساب المهندس، والمهندس يشوفهم وما يحذفهمش', async () => {
    const c = await api('POST', `/api/admin/users/${eng.id}/contractors`, { token: admin, body: { name: 'مقاول للمهندس', rateType: 'يومية' } });
    expect(c.status).toBe(201);
    const p = await api('POST', `/api/admin/users/${eng.id}/places`, { token: admin, body: { name: 'عمارة 30' } });
    expect(p.status).toBe(201);

    const contractors = await api('GET', '/api/contractors', { token: eng.token });
    expect(contractors.body.data.map((x: { name: string }) => x.name)).toContain('مقاول للمهندس');
    const places = await api('GET', '/api/places', { token: eng.token });
    expect(places.body.data.map((x: { name: string }) => x.name)).toContain('عمارة 30');

    expect((await api('DELETE', `/api/places/${p.body.data.id}`, { token: eng.token })).status).toBe(403);
  });

  test('مسارات /api/admin كلها ممنوعة على المهندس', async () => {
    expect((await api('GET', '/api/admin/users', { token: eng.token })).status).toBe(403);
    expect((await api('POST', `/api/admin/users/${eng.id}/places`, { token: eng.token, body: { name: 'اختراق' } })).status).toBe(403);
  });
});

test('المهام: المهندس يعمل مهمة ويخلّصها، ومهندس تاني ما يشوفهاش', async () => {
  const admin = (await loginAdmin()).token;
  const a = await createEngineer(admin, 'todo-a');
  const b = await createEngineer(admin, 'todo-b');

  const created = await api('POST', '/api/todos', { token: a.token, body: { date: '2026-08-20', notes: 'مهمة e2e', place: 'عمارة 27', priority: 'عاجل' } });
  expect(created.status).toBe(201);
  const id = String(created.body.data.id);
  const done = await api('PUT', `/api/todos/${id}`, { token: a.token, body: { done: true } });
  expect(done.body.data.done).toBe(true);

  const bList = await api('GET', '/api/todos', { token: b.token });
  expect(bList.body.data.map((t: { id: unknown }) => String(t.id))).not.toContain(id);
  expect((await api('PUT', `/api/todos/${id}`, { token: b.token, body: { done: false } })).status).toBe(404);
});
