import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';

// اعتمادات المديرين — سلسلة المراجعة داخل التطبيق قبل جوجل شيت
// (ملاحظة: جوجل شيت غير مفعّل في الاختبارات، فالدفع النهائي بيتخطّى بأمان — المهم منطق السلسلة)

const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x74, 0x65, 0x73, 0x74]); // PK.. توقيع xlsx

async function submit(token: string) {
  const res = await request(app).post('/api/submissions').set(auth(token))
    .field('contractorName', 'مقاول').field('placeName', 'موقع').field('weekStart', '2026-08-12')
    .field('weekEnd', '2026-08-18').field('total', '500').field('recordsCount', '2')
    .attach('file', xlsx, 'k.xlsx');
  return res;
}
async function setLevel(adminToken: string, userId: string, level: string | null) {
  return request(app).patch(`/api/admin/users/${userId}`).set(auth(adminToken)).send({ approvalLevel: level });
}
async function enableApprovals(adminToken: string, userId: string, extra: string[] = []) {
  return request(app).put(`/api/admin/users/${userId}/settings`).set(auth(adminToken))
    .send({ enabledModules: ['records', 'submissions', 'approvals', ...extra] });
}

describe('اعتمادات المديرين', () => {
  let admin: TestUser, eng: TestUser, tl: TestUser, pm: TestUser;

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    eng = await createEngineer(admin.token, 'eng@test.com');
    tl = await createEngineer(admin.token, 'tl@test.com');
    pm = await createEngineer(admin.token, 'pm@test.com');
    // team leader + project manager معتمدين (نتخطى construction manager عمدًا → مستوى غير نشط)
    await setLevel(admin.token, tl.id, 'team leader');
    await setLevel(admin.token, pm.id, 'project manager');
    await enableApprovals(admin.token, tl.id);
    await enableApprovals(admin.token, pm.id);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('كشف جديد يدخل السلسلة عند أول مستوى نشط (team leader) ومايتبعتش لجوجل', async () => {
    const res = await submit(eng.token);
    expect(res.status).toBe(201);
    expect(res.body.data.reviewState).toBe('IN_REVIEW');
    expect(res.body.data.currentLevel).toBe('team leader');
    expect(res.body.data.revision).toBe(0);
    expect(res.body.data.gsheetRow).toBeFalsy();
  });

  it('المستوى الأعلى (pm) مايقدرش يعتمد قبل دوره؛ الـ tl يعتمد فيفتح للـ pm', async () => {
    const sub = (await request(app).get('/api/approvals/queue').set(auth(tl.token))).body.data[0];
    // pm يحاول يعتمد بدري → مرفوض
    const early = await request(app).post(`/api/approvals/${sub.id}/decide`).set(auth(pm.token)).send({ decision: 'APPROVED' });
    expect(early.status).toBe(403);
    // tl يعتمد → المستوى ينتقل لـ pm (construction manager اتخطّى لأنه بدون معتمد)
    const t = await request(app).post(`/api/approvals/${sub.id}/decide`).set(auth(tl.token)).send({ decision: 'APPROVED' });
    expect(t.status).toBe(200);
    expect(t.body.data.currentLevel).toBe('project manager');
    expect(t.body.data.reviewState).toBe('IN_REVIEW');
  });

  it('آخر معتمد (pm) يعتمد → السلسلة تخلص والحالة SENT', async () => {
    const sub = (await request(app).get('/api/approvals/queue').set(auth(pm.token))).body.data.find((s: { currentLevel: string }) => s.currentLevel === 'project manager');
    const p = await request(app).post(`/api/approvals/${sub.id}/decide`).set(auth(pm.token)).send({ decision: 'APPROVED_NOTES', note: 'تمام مع ملاحظة بسيطة' });
    expect(p.status).toBe(200);
    expect(p.body.data.reviewState).toBe('SENT');
    expect(p.body.data.currentLevel).toBeNull();
    expect(p.body.data.reviews.length).toBe(2); // tl + pm
  });

  it('الرفض بملاحظة يرجّع الكشف للمهندس (RETURNED)، وإعادة الإرسال تزوّد النسخة وتبدأ السلسلة من أولها', async () => {
    const res = await submit(eng.token);
    const id = res.body.data.id;
    // الرفض لازم معاه ملاحظة
    const noNote = await request(app).post(`/api/approvals/${id}/decide`).set(auth(tl.token)).send({ decision: 'REJECTED' });
    expect(noNote.status).toBe(400);
    const rej = await request(app).post(`/api/approvals/${id}/decide`).set(auth(tl.token)).send({ decision: 'REJECTED', note: 'الإجمالي غلط' });
    expect(rej.body.data.reviewState).toBe('RETURNED');

    // المهندس يشوف الحالة في تسليماته
    const mine = (await request(app).get('/api/submissions/mine').set(auth(eng.token))).body.data.find((s: { id: string }) => s.id === id);
    expect(mine.reviewState).toBe('RETURNED');

    // إعادة الإرسال → rev 1 والسلسلة رجعت لـ team leader
    const resend = await request(app).post(`/api/submissions/${id}/resend`).set(auth(eng.token)).attach('file', xlsx, 'k2.xlsx');
    expect(resend.status).toBe(200);
    expect(resend.body.data.revision).toBe(1);
    expect(resend.body.data.currentLevel).toBe('team leader');
    expect(resend.body.data.reviewState).toBe('IN_REVIEW');
  });

  it('المعتمد (مش صاحب الملف ولا أدمن) يقدر يفتح ملف الكشف من مسار الاعتمادات', async () => {
    const res = await submit(eng.token);
    const id = res.body.data.id;
    // مسار التسليمات بيرفضه (مش صاحب الملف) — ده المتوقع
    const viaSubs = await request(app).get(`/api/submissions/${id}/file`).set(auth(tl.token));
    expect([403, 404]).toContain(viaSubs.status);
    // مسار الاعتمادات بيسمح له
    const viaApr = await request(app).get(`/api/approvals/${id}/file`).set(auth(tl.token));
    expect(viaApr.status).toBe(200);
    expect(viaApr.headers['content-disposition']).toContain('attachment');
    // ومن غير وحدة approvals → ممنوع
    const denied = await request(app).get(`/api/approvals/${id}/file`).set(auth(eng.token));
    expect(denied.status).toBe(403);
  });

  it('الوحدة محمية: حساب من غير صلاحية approvals مايوصلش للطابور', async () => {
    const denied = await request(app).get('/api/approvals/queue').set(auth(eng.token));
    expect(denied.status).toBe(403);
  });

  it('لو مفيش معتمدين مضبوطين خالص → الكشف يتبعت فورًا (السلوك القديم)', async () => {
    await setLevel(admin.token, tl.id, null);
    await setLevel(admin.token, pm.id, null);
    const res = await submit(eng.token);
    expect(res.status).toBe(201);
    // مفيش مستويات نشطة → SENT فورًا (الدفع لجوجل بيتخطّى لأن الربط مطفي في الاختبار)
    const fresh = await prisma.submission.findUnique({ where: { id: BigInt(res.body.data.id) } });
    expect(fresh?.reviewState).toBe('SENT');
    // نرجّع التعيين لبقية الاختبارات لو فيه
    await setLevel(admin.token, tl.id, 'team leader');
    await setLevel(admin.token, pm.id, 'project manager');
  });

  it('الأدمن يقدر يعدّل أسماء المستويات', async () => {
    const put = await request(app).put('/api/admin/approval-levels').set(auth(admin.token))
      .send({ levels: ['team leader', 'construction manager', 'project manager', 'general manager'] });
    expect(put.status).toBe(200);
    expect(put.body.data).toContain('general manager');
  });

  it('إعادة تسمية مستوى وفيه كشف واقف عنده: الكشف يفضل معلّقًا (مايتبعتش قبل أوانه) والأدمن بس يحرّكه', async () => {
    const res = await submit(eng.token);
    const id = res.body.data.id;
    expect(res.body.data.currentLevel).toBe('team leader');

    // الأدمن يعيد تسمية "team leader" → "lead" والكشف لسه واقف عند الاسم القديم
    await request(app).put('/api/admin/approval-levels').set(auth(admin.token))
      .send({ levels: ['lead', 'construction manager', 'project manager'] });

    // الطابور: المستويات النشطة بقت pm بس (tl مستواه مش في القائمة) وصاحب الاسم القديم مش دوره
    const q = await request(app).get('/api/approvals/queue').set(auth(tl.token));
    expect(q.body.activeLevels).toEqual(['project manager']);
    const row = q.body.data.find((s: { id: string }) => s.id === id);
    expect(row.reviewState).toBe('IN_REVIEW');
    expect(row.canAct).toBe(false);

    // tl يحاول يعتمد → مرفوض، والكشف لسه IN_REVIEW عند نفس المستوى (مش SENT)
    const tlTry = await request(app).post(`/api/approvals/${id}/decide`).set(auth(tl.token)).send({ decision: 'APPROVED' });
    expect(tlTry.status).toBe(400);
    const still = await prisma.submission.findUnique({ where: { id: BigInt(id) } });
    expect(still?.reviewState).toBe('IN_REVIEW');
    expect(still?.currentLevel).toBe('team leader');

    // الأدمن يفكّه → يكمّل من أول مستوى نشط (project manager) بدل ما يتبعت لجوجل
    const adm = await request(app).post(`/api/approvals/${id}/decide`).set(auth(admin.token)).send({ decision: 'APPROVED' });
    expect(adm.status).toBe(200);
    expect(adm.body.data.reviewState).toBe('IN_REVIEW');
    expect(adm.body.data.currentLevel).toBe('project manager');

    // نرجّع الأسماء الافتراضية
    await request(app).put('/api/admin/approval-levels').set(auth(admin.token))
      .send({ levels: ['team leader', 'construction manager', 'project manager'] });
  });
});
