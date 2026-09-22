import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';

// طلبات الإيجار (معدات/عمالة) — المهندس يطلب، مدير المشروع يعتمد/يرفض قبل أي تعاقد فعلي

async function enableRent(adminToken: string, userId: string, extra: string[] = []) {
  return request(app).put(`/api/admin/users/${userId}/settings`).set(auth(adminToken))
    .send({ enabledModules: ['records', 'submissions', 'todo', 'summary', 'rent_requests', ...extra] });
}
async function patchUser(adminToken: string, userId: string, body: Record<string, unknown>) {
  return request(app).patch(`/api/admin/users/${userId}`).set(auth(adminToken)).send(body);
}
async function seedContractor(adminToken: string, userId: string, name: string) {
  const res = await request(app).post(`/api/admin/users/${userId}/contractors`).set(auth(adminToken)).send({ name });
  return res.body.data.id as string;
}
async function seedPlace(adminToken: string, userId: string, name: string) {
  const res = await request(app).post(`/api/admin/users/${userId}/places`).set(auth(adminToken)).send({ name });
  return res.body.data.id as string;
}

const baseLine = { day: 'السبت', date: '2026-09-12', qty: 2, qtyType: 'يومية', price: 100 };

describe('طلبات الإيجار', () => {
  let admin: TestUser, eng: TestUser, otherEng: TestUser, pm: TestUser, noRentEng: TestUser;
  let contractorId: string, placeId: string, otherContractorId: string;

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    eng = await createEngineer(admin.token, 'eng-rent@test.com');
    otherEng = await createEngineer(admin.token, 'eng-rent-other@test.com');
    pm = await createEngineer(admin.token, 'pm-rent@test.com');
    noRentEng = await createEngineer(admin.token, 'eng-no-rent@test.com');

    await enableRent(admin.token, eng.id);
    await enableRent(admin.token, otherEng.id);
    await enableRent(admin.token, pm.id);
    await patchUser(admin.token, pm.id, { grade: 'project manager' });
    // noRentEng: بلا وحدة rent_requests عمدًا — لاختبار الحارس

    contractorId = await seedContractor(admin.token, eng.id, 'مقاول الإيجار');
    placeId = await seedPlace(admin.token, eng.id, 'موقع الإيجار');
    otherContractorId = await seedContractor(admin.token, otherEng.id, 'مقاول تاني');
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('الوحدة محمية: حساب بدون rent_requests يتمنع', async () => {
    const denied = await request(app).get('/api/rent-requests').set(auth(noRentEng.token));
    expect(denied.status).toBe(403);
  });

  it('إنشاء طلب: PENDING ورقم مولّد على السيرفر', async () => {
    const res = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'EQUIPMENT', ...baseLine, statementOfWork: 'حفر أساسات' });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING');
    expect(res.body.data.requestNo).toMatch(/^RR-\d{6}-\d{4}$/);
  });

  it('مقاول حساب تاني مرفوض', async () => {
    const res = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId: otherContractorId, placeId, resourceType: 'EQUIPMENT', ...baseLine, statementOfWork: 'عمل ما' });
    expect(res.status).toBe(400);
  });

  it('status وrequestNo من العميل بيتجاهلوا', async () => {
    const res = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'LABOR', ...baseLine, statementOfWork: 'عمالة نظافة', status: 'APPROVED', requestNo: 'FAKE-001' });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING');
    expect(res.body.data.requestNo).not.toBe('FAKE-001');
  });

  it('qty صفر أو سالب أو price سالب مرفوض', async () => {
    const zero = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'EQUIPMENT', ...baseLine, qty: 0, statementOfWork: 'x' });
    expect(zero.status).toBe(400);
    const negQty = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'EQUIPMENT', ...baseLine, qty: -1, statementOfWork: 'x' });
    expect(negQty.status).toBe(400);
    const negPrice = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'EQUIPMENT', ...baseLine, price: -1, statementOfWork: 'x' });
    expect(negPrice.status).toBe(400);
  });

  it('qtyType غير صحيح مرفوض', async () => {
    const res = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'EQUIPMENT', ...baseLine, qtyType: 'شهرية', statementOfWork: 'x' });
    expect(res.status).toBe(400);
  });

  it('dateFrom/dateTo القديمين اتشالوا — لو اتبعتوا بيتجاهلوا ومبيتخزنوش', async () => {
    const res = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'EQUIPMENT', ...baseLine, statementOfWork: 'قديم', dateFrom: '2026-01-01', dateTo: '2026-01-05' });
    expect(res.status).toBe(201);
    expect(res.body.data.dateFrom).toBeUndefined();
    expect(res.body.data.dateTo).toBeUndefined();
  });

  it('total بيتحسب على السيرفر (qty × price) وبيتجاهل أي total من العميل', async () => {
    const res = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'EQUIPMENT', ...baseLine, statementOfWork: 'حساب الإجمالي', total: 999999 });
    expect(res.status).toBe(201);
    expect(Number(res.body.data.total)).toBe(baseLine.qty * baseLine.price);
  });

  it('الطلب المُنشأ بيرجّع نفس بيانات السطر (day/date/qty/qtyType/price/total)', async () => {
    const res = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'EQUIPMENT', ...baseLine, statementOfWork: 'راوند تريب' });
    expect(res.status).toBe(201);
    expect(res.body.data.day).toBe(baseLine.day);
    expect(res.body.data.date).toBe(baseLine.date);
    expect(Number(res.body.data.qty)).toBe(baseLine.qty);
    expect(res.body.data.qtyType).toBe(baseLine.qtyType);
    expect(Number(res.body.data.price)).toBe(baseLine.price);
    expect(Number(res.body.data.total)).toBe(baseLine.qty * baseLine.price);
  });

  it('مهندس مش مدير مشروع ولا أدمن ممنوع من القرار', async () => {
    const created = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'EQUIPMENT', ...baseLine, statementOfWork: 'اختبار صلاحية' });
    const res = await request(app).post(`/api/rent-requests/${created.body.data.id}/decide`).set(auth(eng.token))
      .send({ decision: 'APPROVED' });
    expect(res.status).toBe(403);
  });

  it('مدير المشروع يعتمد/يعتمد بملاحظات/يرفض — وكل قرار يسجل مراجعة واحدة بالظبط', async () => {
    const mk = async () => (await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'EQUIPMENT', ...baseLine, statementOfWork: 'اختبار قرار' })).body.data.id;

    const idApprove = await mk();
    const approve = await request(app).post(`/api/rent-requests/${idApprove}/decide`).set(auth(pm.token)).send({ decision: 'APPROVED' });
    expect(approve.status).toBe(200);
    expect(approve.body.data.status).toBe('APPROVED');
    const detA = await request(app).get(`/api/rent-requests/${idApprove}`).set(auth(pm.token));
    expect(detA.body.data.reviews.length).toBe(1);

    const idNotes = await mk();
    const notes = await request(app).post(`/api/rent-requests/${idNotes}/decide`).set(auth(pm.token)).send({ decision: 'APPROVED_NOTES', note: 'راجع المدة' });
    expect(notes.status).toBe(200);
    expect(notes.body.data.status).toBe('APPROVED_NOTES');
    const detN = await request(app).get(`/api/rent-requests/${idNotes}`).set(auth(pm.token));
    expect(detN.body.data.reviews.length).toBe(1);

    const idReject = await mk();
    const reject = await request(app).post(`/api/rent-requests/${idReject}/decide`).set(auth(pm.token)).send({ decision: 'REJECTED', note: 'مش مطلوب دلوقتي' });
    expect(reject.status).toBe(200);
    expect(reject.body.data.status).toBe('REJECTED');
    const detR = await request(app).get(`/api/rent-requests/${idReject}`).set(auth(pm.token));
    expect(detR.body.data.reviews.length).toBe(1);
  });

  it('قائمة الطلبات بترجّع reviews وتعرض ملاحظة القرار من غير فتح كل طلب لوحده', async () => {
    const created = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'EQUIPMENT', ...baseLine, statementOfWork: 'اختبار القائمة' });
    const id = created.body.data.id;

    const beforeDecision = await request(app).get('/api/rent-requests').set(auth(eng.token));
    expect(beforeDecision.status).toBe(200);
    const rowBefore = beforeDecision.body.data.find((r: { id: string }) => r.id === id);
    expect(Array.isArray(rowBefore.reviews)).toBe(true);
    expect(rowBefore.reviews.length).toBe(0);

    await request(app).post(`/api/rent-requests/${id}/decide`).set(auth(pm.token))
      .send({ decision: 'APPROVED_NOTES', note: 'راجع الكمية قبل التنفيذ' });

    const afterDecision = await request(app).get('/api/rent-requests').set(auth(eng.token));
    const rowAfter = afterDecision.body.data.find((r: { id: string }) => r.id === id);
    expect(rowAfter.reviews.length).toBe(1);
    expect(rowAfter.reviews[0].note).toBe('راجع الكمية قبل التنفيذ');
  });

  it('اعتماد بملاحظات أو رفض بلا ملاحظة مرفوض', async () => {
    const created = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'EQUIPMENT', ...baseLine, statementOfWork: 'بلا ملاحظة' });
    const id = created.body.data.id;
    const notesNoNote = await request(app).post(`/api/rent-requests/${id}/decide`).set(auth(pm.token)).send({ decision: 'APPROVED_NOTES' });
    expect(notesNoNote.status).toBe(400);
    const rejectNoNote = await request(app).post(`/api/rent-requests/${id}/decide`).set(auth(pm.token)).send({ decision: 'REJECTED' });
    expect(rejectNoNote.status).toBe(400);
  });

  it('القرار على طلب اتقرر فيه بالفعل مرفوض', async () => {
    const created = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'EQUIPMENT', ...baseLine, statementOfWork: 'مرتين' });
    const id = created.body.data.id;
    const first = await request(app).post(`/api/rent-requests/${id}/decide`).set(auth(pm.token)).send({ decision: 'APPROVED' });
    expect(first.status).toBe(200);
    const second = await request(app).post(`/api/rent-requests/${id}/decide`).set(auth(pm.token)).send({ decision: 'REJECTED', note: 'متأخر' });
    expect(second.status).toBe(400);
  });

  it('قراران متزامنان على طلب إيجار يسجّلان مراجعة واحدة فقط', async () => {
    const created = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'EQUIPMENT', ...baseLine, statementOfWork: 'قرار متزامن' });
    const id = created.body.data.id;
    const attempts = await Promise.all([
      request(app).post(`/api/rent-requests/${id}/decide`).set(auth(pm.token)).send({ decision: 'APPROVED' }),
      request(app).post(`/api/rent-requests/${id}/decide`).set(auth(pm.token)).send({ decision: 'REJECTED', note: 'قرار متزامن' }),
    ]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 400]);

    const details = await request(app).get(`/api/rent-requests/${id}`).set(auth(pm.token));
    expect(details.body.data.reviews).toHaveLength(1);
  });

  it('المهندس غير الأدمن يشوف طلباته هو بس', async () => {
    await request(app).post('/api/rent-requests').set(auth(otherEng.token))
      .send({ contractorId: otherContractorId, placeId: await seedPlace(admin.token, otherEng.id, 'مكان تاني'), resourceType: 'LABOR', ...baseLine, statementOfWork: 'عمالة تانية' });
    const mine = await request(app).get('/api/rent-requests').set(auth(eng.token));
    expect(mine.status).toBe(200);
    expect(mine.body.data.length).toBeGreaterThan(0);
    expect(mine.body.data.every((r: { userId: string }) => r.userId === eng.id)).toBe(true);
  });

  it('قائمة الطلبات بترجّع اسم المهندس صاحب الطلب (لتاب اعتماد طلبات الإيجار)', async () => {
    await patchUser(admin.token, eng.id, { displayName: 'أحمد المهندس' });
    const created = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'EQUIPMENT', ...baseLine, statementOfWork: 'اختبار اسم المهندس' });
    const list = await request(app).get('/api/rent-requests').set(auth(pm.token));
    expect(list.status).toBe(200);
    const row = list.body.data.find((r: { id: string }) => r.id === created.body.data.id);
    expect(row.user).toBeTruthy();
    expect(row.user.displayName).toBe('أحمد المهندس');
    expect(row.createdAt).toEqual(expect.any(String));
  });

  it('GET /approved يرجّع المعتمد بس (بنوعيه) ويطبّق الفلاتر', async () => {
    const place2 = await seedPlace(admin.token, eng.id, 'مكان اعتماد');
    const pending = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId: place2, resourceType: 'LABOR', ...baseLine, statementOfWork: 'لسه معلق' });

    const approvedList = await request(app).get('/api/rent-requests/approved').set(auth(eng.token));
    expect(approvedList.status).toBe(200);
    const statuses = new Set(approvedList.body.data.map((r: { status: string }) => r.status));
    for (const s of statuses) expect(['APPROVED', 'APPROVED_NOTES']).toContain(s);
    expect(approvedList.body.data.some((r: { id: string }) => r.id === pending.body.data.id)).toBe(false);

    const byPlace = await request(app).get('/api/rent-requests/approved').set(auth(eng.token)).query({ placeId: place2 });
    expect(byPlace.body.data.length).toBe(0); // الطلب على place2 لسه PENDING

    const byResource = await request(app).get('/api/rent-requests/approved').set(auth(eng.token)).query({ resourceType: 'EQUIPMENT' });
    expect(byResource.body.data.every((r: { resourceType: string }) => r.resourceType === 'EQUIPMENT')).toBe(true);
  });
});

// ═══════════ ربط طلب الإيجار بسطر السركي — طلب واحد = سطر واحد ═══════════
// الثغرة اللي القيد ده بيقفلها: المهندس ياخد طلب إيجار معتمد واحد ويسجّله في أكتر من سطر سركي،
// فيتحاسب أكتر من مرة على نفس الشغل. الضمان النهائي UNIQUE على records.rent_request_id.
describe('ربط طلب الإيجار بالسركي', () => {
  let admin: TestUser, eng: TestUser, otherEng: TestUser, pm: TestUser;
  let contractorId: string, placeId: string;

  const recordLine = {
    day: 'السبت', date: '2026-09-12', contractor: 'مقاول الربط', place: 'موقع الربط',
    qty: 2, qtyType: 'يومية', price: 100, discount: 0, spec: '', notes: 'شغل الطلب', deductOn: [], deductNote: '',
  };

  // طلب جديد + اعتماده من مدير المشروع → بيرجّع الـid جاهز للربط
  async function approvedRequest(sow = 'حفر أساسات') {
    const created = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'EQUIPMENT', day: 'السبت', date: '2026-09-12', qty: 2, qtyType: 'يومية', price: 100, statementOfWork: sow });
    const id = created.body.data.id as string;
    await request(app).post(`/api/rent-requests/${id}/decide`).set(auth(pm.token)).send({ decision: 'APPROVED' });
    return id;
  }

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    eng = await createEngineer(admin.token, 'eng-link@test.com');
    otherEng = await createEngineer(admin.token, 'eng-link-other@test.com');
    pm = await createEngineer(admin.token, 'pm-link@test.com');
    await enableRent(admin.token, eng.id);
    await enableRent(admin.token, otherEng.id);
    await enableRent(admin.token, pm.id);
    await patchUser(admin.token, pm.id, { grade: 'project manager' });
    contractorId = await seedContractor(admin.token, eng.id, 'مقاول الربط');
    placeId = await seedPlace(admin.token, eng.id, 'موقع الربط');
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('سجل متربط بطلب معتمد يتقبل ويرجّع rentRequestId', async () => {
    const rrId = await approvedRequest();
    const res = await request(app).post('/api/records').set(auth(eng.token)).send({ ...recordLine, rentRequestId: rrId });
    expect(res.status).toBe(201);
    expect(String(res.body.data.rentRequestId)).toBe(String(rrId));
  });

  it('🔒 نفس الطلب في سجل تاني يترفض', async () => {
    const rrId = await approvedRequest();
    const first = await request(app).post('/api/records').set(auth(eng.token)).send({ ...recordLine, rentRequestId: rrId });
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/records').set(auth(eng.token)).send({ ...recordLine, rentRequestId: rrId });
    expect(second.status).toBe(400);
    expect(second.body.message).toContain('متسجّل قبل كده');
  });

  it('طلب لسه PENDING أو مرفوض ما ينفعش يتربط', async () => {
    const pending = await request(app).post('/api/rent-requests').set(auth(eng.token))
      .send({ contractorId, placeId, resourceType: 'LABOR', day: 'السبت', date: '2026-09-12', qty: 1, qtyType: 'يومية', price: 50, statementOfWork: 'لسه معلق' });
    const res = await request(app).post('/api/records').set(auth(eng.token)).send({ ...recordLine, rentRequestId: pending.body.data.id });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('معتمد');

    await request(app).post(`/api/rent-requests/${pending.body.data.id}/decide`).set(auth(pm.token)).send({ decision: 'REJECTED', note: 'مش مطلوب' });
    const afterReject = await request(app).post('/api/records').set(auth(eng.token)).send({ ...recordLine, rentRequestId: pending.body.data.id });
    expect(afterReject.status).toBe(400);
  });

  it('طلب مهندس تاني ما ينفعش يتربط', async () => {
    const rrId = await approvedRequest();
    const res = await request(app).post('/api/records').set(auth(otherEng.token)).send({ ...recordLine, rentRequestId: rrId });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('لا يخصك');
  });

  it('تعديل السجل بنفس طلبه بيعدّي (مش بيتحسب استخدام مكرر)', async () => {
    const rrId = await approvedRequest();
    const created = await request(app).post('/api/records').set(auth(eng.token)).send({ ...recordLine, rentRequestId: rrId });
    const res = await request(app).put(`/api/records/${created.body.data.id}`).set(auth(eng.token))
      .send({ ...recordLine, qty: 3, rentRequestId: rrId });
    expect(res.status).toBe(200);
    expect(String(res.body.data.rentRequestId)).toBe(String(rrId));
  });

  it('مسح السجل بيفك الطلب فيرجع يتسجّل تاني', async () => {
    const rrId = await approvedRequest();
    const created = await request(app).post('/api/records').set(auth(eng.token)).send({ ...recordLine, rentRequestId: rrId });
    await request(app).delete(`/api/records/${created.body.data.id}`).set(auth(eng.token)).expect(200);

    const again = await request(app).post('/api/records').set(auth(eng.token)).send({ ...recordLine, rentRequestId: rrId });
    expect(again.status).toBe(201);
  });

  it('GET /approved?unused=1 بيستبعد الطلبات المستخدَمة، و usedByRecordId بيبان', async () => {
    const rrId = await approvedRequest('طلب للاستبعاد');
    const before = await request(app).get('/api/rent-requests/approved').set(auth(eng.token)).query({ unused: '1' });
    expect(before.body.data.some((r: { id: string }) => r.id === rrId)).toBe(true);

    const rec = await request(app).post('/api/records').set(auth(eng.token)).send({ ...recordLine, rentRequestId: rrId });
    const after = await request(app).get('/api/rent-requests/approved').set(auth(eng.token)).query({ unused: '1' });
    expect(after.body.data.some((r: { id: string }) => r.id === rrId)).toBe(false);

    const all = await request(app).get('/api/rent-requests/approved').set(auth(eng.token));
    const row = all.body.data.find((r: { id: string }) => r.id === rrId);
    expect(String(row.usedByRecordId)).toBe(String(rec.body.data.id));
  });

  it('سجل بدون طلب إيجار شغّال زي ما هو (rentRequestId = null)', async () => {
    const res = await request(app).post('/api/records').set(auth(eng.token)).send(recordLine);
    expect(res.status).toBe(201);
    expect(res.body.data.rentRequestId ?? null).toBeNull();
  });
});
