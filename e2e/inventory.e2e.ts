import { describe, test, expect } from 'e2e';
import { api, createEngineer, loginAdmin, type Session } from './helpers';

// المخزن: الأدمن بيدير الأصناف والحركات، والمهندس بيطلب صرف ← اعتماد ← صرف = خصم من الرصيد
describe('المخزن', { serial: true }, () => {
  let admin: string;
  let eng: Session;
  let itemId: string;
  const code = `CEM-${Date.now()}`;

  test('الوحدة محمية: مهندس من غير الوحدة 403، واللي مفعّلة له يقرا', async () => {
    admin = (await loginAdmin()).token;
    eng = await createEngineer(admin, 'inv-eng', ['records', 'submissions', 'inventory']);
    const denied = await createEngineer(admin, 'inv-denied');
    expect((await api('GET', '/api/inventory/items', { token: denied.token })).status).toBe(403);
    expect((await api('GET', '/api/inventory/items', { token: eng.token })).status).toBe(200);
  });

  test('الأدمن يضيف صنف برصيد افتتاحي → حركة وارد، والكود ما يتكررش', async () => {
    const res = await api('POST', '/api/inventory/items', {
      token: admin,
      body: { code, name: 'أسمنت', unit: 'شيكارة', category: 'خرسانة', qty: 100, minQty: 20 },
    });
    expect(res.status).toBe(201);
    itemId = String(res.body.data.id);
    const moves = await api('GET', `/api/inventory/items/${itemId}/moves`, { token: eng.token });
    expect(moves.body.data).toHaveLength(1);
    expect(moves.body.data[0].type).toBe('IN');
    const dup = await api('POST', '/api/inventory/items', { token: admin, body: { code, name: 'تاني', unit: 'شيكارة' } });
    expect(dup.status).toBe(400);
  });

  test('المهندس ما يضيفش أصناف ولا حركات', async () => {
    const item = await api('POST', '/api/inventory/items', { token: eng.token, body: { code: 'X-1', name: 'x', unit: 'عدد' } });
    expect(item.status).toBe(403);
    const move = await api('POST', `/api/inventory/items/${itemId}/move`, { token: eng.token, body: { type: 'IN', qty: 10 } });
    expect(move.status).toBe(403);
  });

  test('طلب صرف أكبر من الرصيد بيترفض فورًا', async () => {
    const res = await api('POST', '/api/inventory/issue-requests', { token: eng.token, body: { lines: [{ itemId, qty: 999 }] } });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('غير كافية');
  });

  test('دورة الصرف: طلب ← (الصرف قبل الاعتماد مرفوض) ← اعتماد ← صرف مرة واحدة بس ← خصم', async () => {
    const created = await api('POST', '/api/inventory/issue-requests', {
      token: eng.token,
      body: { lines: [{ itemId, qty: 40 }], note: 'للبياض' },
    });
    expect(created.status).toBe(201);
    const reqId = String(created.body.data.id);

    const early = await api('POST', `/api/inventory/issue-requests/${reqId}/fulfill`, { token: admin });
    expect(early.status).toBe(400);

    const approved = await api('PATCH', `/api/inventory/issue-requests/${reqId}/review`, { token: admin, body: { status: 'APPROVED' } });
    expect(approved.body.data.status).toBe('APPROVED');

    // طلبين صرف في نفس اللحظة: واحد بس يعدّي — مفيش خصم مزدوج
    const attempts = await Promise.all([
      api('POST', `/api/inventory/issue-requests/${reqId}/fulfill`, { token: admin }),
      api('POST', `/api/inventory/issue-requests/${reqId}/fulfill`, { token: admin }),
    ]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 400]);

    const items = await api('GET', '/api/inventory/items', { token: eng.token });
    expect(Number(items.body.data.find((i: { id: unknown }) => String(i.id) === itemId).qty)).toBe(60);
    const moves = await api('GET', `/api/inventory/items/${itemId}/moves`, { token: admin });
    expect(moves.body.data[0].type).toBe('OUT');
  });
});
