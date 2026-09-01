import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';

// وحدة المخازن — المسارات الحرجة: الصلاحيات، دفتر الحركات، الخصم الذري بشرط الكفاية، لقطة طلب الشراء

describe('المخازن', () => {
  let admin: TestUser;
  let eng: TestUser; // مهندس مفعّل له وحدة المخازن
  let eng2: TestUser; // مهندس بدون الوحدة
  let cementId: string;
  let steelId: string;

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    eng = await createEngineer(admin.token, 'eng-inv@test.com');
    eng2 = await createEngineer(admin.token, 'eng-noinv@test.com');
    // تفعيل وحدة المخازن للمهندس الأول فقط
    const r = await request(app)
      .put(`/api/admin/users/${eng.id}/settings`)
      .set(auth(admin.token))
      .send({ enabledModules: ['records', 'submissions', 'todo', 'summary', 'inventory'] });
    expect(r.status).toBe(200);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('الوحدة محمية: مهندس غير مفعّلة له = 403، والمفعّلة له يقرأ', async () => {
    const denied = await request(app).get('/api/inventory/items').set(auth(eng2.token));
    expect(denied.status).toBe(403);
    const ok = await request(app).get('/api/inventory/items').set(auth(eng.token));
    expect(ok.status).toBe(200);
  });

  it('الأدمن يضيف صنفًا برصيد افتتاحي → حركة وارد تتسجل، والكود الفريد يمنع التكرار', async () => {
    const res = await request(app).post('/api/inventory/items').set(auth(admin.token))
      .send({ code: 'CEM-01', name: 'أسمنت', unit: 'شيكارة', category: 'خرسانة', qty: 100, minQty: 20 });
    expect(res.status).toBe(201);
    cementId = res.body.data.id;
    const moves = await request(app).get(`/api/inventory/items/${cementId}/moves`).set(auth(eng.token));
    expect(moves.body.data.length).toBe(1);
    expect(moves.body.data[0].type).toBe('IN');
    const dup = await request(app).post('/api/inventory/items').set(auth(admin.token))
      .send({ code: 'CEM-01', name: 'تاني', unit: 'شيكارة' });
    expect(dup.status).toBe(400);

    const steel = await request(app).post('/api/inventory/items').set(auth(admin.token))
      .send({ code: 'STL-12', name: 'حديد 12', unit: 'طن', qty: 5 });
    steelId = steel.body.data.id;
  });

  it('المهندس لا يضيف أصنافًا ولا حركات (أدمن فقط)', async () => {
    const item = await request(app).post('/api/inventory/items').set(auth(eng.token))
      .send({ code: 'X-1', name: 'x', unit: 'عدد' });
    expect(item.status).toBe(403);
    const move = await request(app).post(`/api/inventory/items/${cementId}/move`).set(auth(eng.token))
      .send({ type: 'IN', qty: 10 });
    expect(move.status).toBe(403);
  });

  it('وارد يزوّد، وتسوية الجرد تضبط بالعدد الفعلي وتتطلب سببًا', async () => {
    const inn = await request(app).post(`/api/inventory/items/${cementId}/move`).set(auth(admin.token))
      .send({ type: 'IN', qty: 50, note: 'شحنة' });
    expect(Number(inn.body.data.qty)).toBe(150);
    const noReason = await request(app).post(`/api/inventory/items/${cementId}/move`).set(auth(admin.token))
      .send({ type: 'ADJUST', qty: 140 });
    expect(noReason.status).toBe(400);
    const adj = await request(app).post(`/api/inventory/items/${cementId}/move`).set(auth(admin.token))
      .send({ type: 'ADJUST', qty: 140, note: 'عجز جرد' });
    expect(Number(adj.body.data.qty)).toBe(140);
  });

  it('طلب صرف بكمية أكبر من المتاح يُرفض فورًا برسالة توجيه', async () => {
    const res = await request(app).post('/api/inventory/issue-requests').set(auth(eng.token))
      .send({ lines: [{ itemId: cementId, qty: 999 }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('غير كافية');
    expect(res.body.message).toContain('طلب شراء');
  });

  it('دورة الصرف كاملة: إرسال → اعتماد → تم الصرف = خصم + حركة OUT', async () => {
    const created = await request(app).post('/api/inventory/issue-requests').set(auth(eng.token))
      .send({ lines: [{ itemId: cementId, qty: 40 }], note: 'للبياض' });
    expect(created.status).toBe(201);
    const reqId = created.body.data.id;

    // الصرف قبل الاعتماد مرفوض
    const early = await request(app).post(`/api/inventory/issue-requests/${reqId}/fulfill`).set(auth(admin.token));
    expect(early.status).toBe(400);

    const approved = await request(app).patch(`/api/inventory/issue-requests/${reqId}/review`).set(auth(admin.token))
      .send({ status: 'APPROVED' });
    expect(approved.body.data.status).toBe('APPROVED');

    const done = await request(app).post(`/api/inventory/issue-requests/${reqId}/fulfill`).set(auth(admin.token));
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('FULFILLED');

    const items = await request(app).get('/api/inventory/items').set(auth(eng.token));
    const cement = items.body.data.find((i: { id: string }) => i.id === cementId);
    expect(Number(cement.qty)).toBe(100); // 140 - 40
    const moves = await request(app).get(`/api/inventory/items/${cementId}/moves`).set(auth(admin.token));
    expect(moves.body.data[0].type).toBe('OUT');
  });

  it('الصرف يفشل ذريًا لو الكمية نقصت بعد الاعتماد — بدون أي خصم جزئي', async () => {
    const created = await request(app).post('/api/inventory/issue-requests').set(auth(eng.token))
      .send({ lines: [{ itemId: steelId, qty: 4 }, { itemId: cementId, qty: 10 }] });
    const reqId = created.body.data.id;
    await request(app).patch(`/api/inventory/issue-requests/${reqId}/review`).set(auth(admin.token)).send({ status: 'APPROVED' });
    // الحديد ينزل لـ 2 (أقل من الـ 4 المطلوبة) قبل الصرف
    await request(app).post(`/api/inventory/items/${steelId}/move`).set(auth(admin.token))
      .send({ type: 'ADJUST', qty: 2, note: 'اتصرف يدوي بره النظام' });

    const fulfill = await request(app).post(`/api/inventory/issue-requests/${reqId}/fulfill`).set(auth(admin.token));
    expect(fulfill.status).toBe(400);

    // الحالة فضلت معتمدة، ومفيش خصم حصل لأي بند (الأسمنت لسه 100 والحديد 2)
    const items = await request(app).get('/api/inventory/items').set(auth(eng.token));
    expect(Number(items.body.data.find((i: { id: string }) => i.id === cementId).qty)).toBe(100);
    expect(Number(items.body.data.find((i: { id: string }) => i.id === steelId).qty)).toBe(2);
    const reqs = await request(app).get('/api/inventory/issue-requests').set(auth(admin.token));
    expect(reqs.body.data.find((r: { id: string }) => r.id === reqId).status).toBe('APPROVED');
  });

  it('المهندس يشوف طلباته فقط، والأدمن يشوف الكل؛ الحذف مسموح للمُرسَل فقط', async () => {
    const mine = await request(app).get('/api/inventory/issue-requests').set(auth(eng.token));
    expect(mine.body.data.every((r: { user: { email: string } }) => r.user.email === eng.email)).toBe(true);

    const created = await request(app).post('/api/inventory/issue-requests').set(auth(eng.token))
      .send({ lines: [{ itemId: cementId, qty: 1 }] });
    const del = await request(app).delete(`/api/inventory/issue-requests/${created.body.data.id}`).set(auth(eng.token));
    expect(del.status).toBe(200);
  });

  it('طلب الشراء يسجّل لقطة الكمية وقت الطلب، والأدمن فقط يغيّر حالته', async () => {
    const res = await request(app).post('/api/inventory/purchase-requests').set(auth(eng.token))
      .send({ itemId: steelId, qtyRequested: 10, note: 'ناقص' });
    expect(res.status).toBe(201);
    expect(Number(res.body.data.qtyAtRequest)).toBe(2);
    const prId = res.body.data.id;

    const engPatch = await request(app).patch(`/api/inventory/purchase-requests/${prId}`).set(auth(eng.token))
      .send({ status: 'PURCHASED' });
    expect(engPatch.status).toBe(403);
    const adminPatch = await request(app).patch(`/api/inventory/purchase-requests/${prId}`).set(auth(admin.token))
      .send({ status: 'PURCHASED' });
    expect(adminPatch.body.data.status).toBe('PURCHASED');
    expect(adminPatch.body.data.resolvedAt).toBeTruthy();
  });

  it('استيراد جماعي: يضيف الجديد ويتخطى الموجود ويسجّل وارد الرصيد', async () => {
    const res = await request(app).post('/api/inventory/items/import').set(auth(admin.token))
      .send({ items: [
        { code: 'CEM-01', name: 'أسمنت مكرر', unit: 'شيكارة' },
        { code: 'SND-01', name: 'رمل', unit: 'م3', category: 'خرسانة', qty: 30, minQty: 5 },
      ] });
    expect(res.status).toBe(200);
    expect(res.body.data.added).toBe(1);
    expect(res.body.data.skipped).toBe(1);
    const items = await request(app).get('/api/inventory/items').set(auth(eng.token));
    const sand = items.body.data.find((i: { code: string }) => i.code === 'SND-01');
    expect(Number(sand.qty)).toBe(30);
  });

  it('الوحدات والفئات: الأدمن يضيف والمهندس يقرأ فقط', async () => {
    const addUnit = await request(app).post('/api/inventory/units').set(auth(admin.token)).send({ unit: 'برميل' });
    expect(addUnit.body.data).toContain('برميل');
    const engUnit = await request(app).post('/api/inventory/units').set(auth(eng.token)).send({ unit: 'x' });
    expect(engUnit.status).toBe(403);
    const cats = await request(app).get('/api/inventory/categories').set(auth(eng.token));
    expect(cats.body.data).toContain('خرسانة');
  });
});
