import { describe, test, expect } from 'e2e';
import { api, createEngineer, loginAdmin } from './helpers';

const baseRecord = {
  day: 'الاثنين',
  date: '2026-08-17',
  contractor: 'علاء أحمد محمود',
  spec: 'مبيض محارة',
  qty: 3,
  qtyType: 'يومية',
  price: 500,
  discount: 100,
  place: 'عمارة 27',
  notes: 'ملاحظة e2e',
};

// المسار الكامل لسركي واحد: إنشاء ← قراءة ← تعديل ← تمّ ← حذف، بنفس الحالة على السيرفر
describe('السراكي (records)', { serial: true }, () => {
  let token: string;
  let id: string;

  test('الإنشاء بيحسب total على السيرفر ويتجاهل أي total مُرسل', async () => {
    token = (await loginAdmin()).token;
    const res = await api('POST', '/api/records', { token, body: { ...baseRecord, total: 999999 } });
    expect(res.status).toBe(201);
    expect(Number(res.body.data.total)).toBe(3 * 500 - 100);
    expect(res.body.data.qtyType).toBe('يومية');
    id = String(res.body.data.id);
  });

  test('القايمة بترجّع pagination والسركي موجود فيها', async () => {
    const res = await api('GET', '/api/records?date_from=2026-08-17&date_to=2026-08-17&page=1&limit=50', { token });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ page: 1, limit: 50 });
    expect(res.body.data.rows.map((r: { id: unknown }) => String(r.id))).toContain(id);
  });

  test('التعديل بيعيد حساب total', async () => {
    const res = await api('PUT', `/api/records/${id}`, { token, body: { ...baseRecord, qty: 4 } });
    expect(res.status).toBe(200);
    expect(Number(res.body.data.total)).toBe(4 * 500 - 100);
  });

  test('toggle-done بيقلب الحالة', async () => {
    const res = await api('PATCH', `/api/records/${id}/toggle-done`, { token });
    expect(res.status).toBe(200);
    expect(res.body.data.done).toBe(true);
  });

  test('الحذف وبعده القراءة بترجع 404', async () => {
    const del = await api('DELETE', `/api/records/${id}`, { token });
    expect(del.status).toBe(200);
    const get = await api('GET', `/api/records/${id}`, { token });
    expect(get.status).toBe(404);
  });
});

test('مهندس الوحدة مش مفعّلة له بياخد 403 على /api/records', async () => {
  const admin = await loginAdmin();
  const eng = await createEngineer(admin.token, 'no-records', ['todo']);
  const res = await api('GET', '/api/records', { token: eng.token });
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('FORBIDDEN');
});

test('مهندس ما يشوفش ولا يعدّل سركي مهندس تاني (IDOR)', async () => {
  const admin = await loginAdmin();
  const a = await createEngineer(admin.token, 'eng-a', ['records']);
  const b = await createEngineer(admin.token, 'eng-b', ['records']);

  const created = await api('POST', '/api/records', { token: b.token, body: baseRecord });
  expect(created.status).toBe(201);
  const recordId = String(created.body.data.id);

  const list = await api('GET', '/api/records', { token: a.token });
  expect(list.status).toBe(200);
  expect(list.body.data.rows.map((r: { id: unknown }) => String(r.id))).not.toContain(recordId);

  for (const [method, body] of [['GET'], ['PUT', { ...baseRecord, qty: 99 }], ['DELETE']] as const) {
    const res = await api(method, `/api/records/${recordId}`, { token: a.token, body });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  }

  const stillThere = await api('GET', `/api/records/${recordId}`, { token: b.token });
  expect(stillThere.status).toBe(200);
  expect(Number(stillThere.body.data.qty)).toBe(baseRecord.qty);
});
