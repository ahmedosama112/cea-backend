import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';

// اعتمادات المديرين — سلسلة المراجعة داخل التطبيق قبل جوجل شيت
// السلسلة بتتحدد لكل مهندس: درجته (المصفوفة) + المعتمدين المسندين له بالاسم
// (ملاحظة: جوجل شيت غير مفعّل في الاختبارات، فالدفع النهائي بيتخطّى بأمان — المهم منطق السلسلة)

const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x74, 0x65, 0x73, 0x74]); // PK.. توقيع xlsx

async function submit(token: string) {
  const res = await request(app).post('/api/submissions').set(auth(token))
    .field('contractorName', 'مقاول').field('placeName', 'موقع').field('weekStart', '2026-08-12')
    .field('weekEnd', '2026-08-18').field('total', '500').field('recordsCount', '2')
    .attach('file', xlsx, 'k.xlsx');
  return res;
}
async function patchUser(adminToken: string, userId: string, body: Record<string, unknown>) {
  return request(app).patch(`/api/admin/users/${userId}`).set(auth(adminToken)).send(body);
}
async function enableApprovals(adminToken: string, userId: string, extra: string[] = []) {
  return request(app).put(`/api/admin/users/${userId}/settings`).set(auth(adminToken))
    .send({ enabledModules: ['records', 'submissions', 'approvals', ...extra] });
}

describe('اعتمادات المديرين', () => {
  let admin: TestUser, eng: TestUser, tl: TestUser, tl2: TestUser, cm: TestUser, pm: TestUser, eng2: TestUser;

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    eng = await createEngineer(admin.token, 'eng@test.com');
    eng2 = await createEngineer(admin.token, 'eng2@test.com');
    tl = await createEngineer(admin.token, 'tl@test.com');
    tl2 = await createEngineer(admin.token, 'tl2@test.com');
    cm = await createEngineer(admin.token, 'cm@test.com');
    pm = await createEngineer(admin.token, 'pm@test.com');
    await patchUser(admin.token, tl.id, { grade: 'team leader' });
    await patchUser(admin.token, tl2.id, { grade: 'team leader' });
    await patchUser(admin.token, cm.id, { grade: 'construction manager' });
    await patchUser(admin.token, pm.id, { grade: 'project manager' });
    // eng (junior): مدير فريقه tl، ومفيش مدير تنفيذ مسند له عمدًا → المستوى ده يتخطى.
    // مدير المشروع مش مسند صراحةً → بيتحدد تلقائيًا لأنه واحد بس في النظام.
    await patchUser(admin.token, eng.id, { approverTlId: tl.id });
    // eng2 مهندس مدير فريقه tl2 — للتأكد إن كل معتمد بيشوف مهندسينه بس
    await patchUser(admin.token, eng2.id, { approverTlId: tl2.id });
    for (const u of [tl, tl2, cm, pm]) await enableApprovals(admin.token, u.id);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('كشف junior يدخل السلسلة عند مدير فريقه المسند، ومايتبعتش لجوجل', async () => {
    const res = await submit(eng.token);
    expect(res.status).toBe(201);
    expect(res.body.data.reviewState).toBe('IN_REVIEW');
    expect(res.body.data.currentLevel).toBe('team leader');
    expect(res.body.data.currentApproverId).toBe(tl.id);
    expect(res.body.data.revision).toBe(0);
    expect(res.body.data.gsheetRow).toBeFalsy();
  });

  it('مدير فريق تاني مايشوفش كشوف مهندسين مش مسندين له ولا يقدر يعتمدها', async () => {
    const sub = (await request(app).get('/api/approvals/queue').set(auth(tl.token))).body.data[0];
    const q2 = await request(app).get('/api/approvals/queue').set(auth(tl2.token));
    expect(q2.body.data.find((s: { id: string }) => s.id === sub.id)).toBeUndefined();
    const tryIt = await request(app).post(`/api/approvals/${sub.id}/decide`).set(auth(tl2.token)).send({ decision: 'APPROVED' });
    expect(tryIt.status).toBe(403);
  });

  it('المستوى الأعلى (pm) مايقدرش يعتمد قبل دوره؛ الـ tl يعتمد فيفتح للـ pm (مدير التنفيذ اتخطى لأنه مش مسند)', async () => {
    const sub = (await request(app).get('/api/approvals/queue').set(auth(tl.token))).body.data[0];
    expect(sub.canAct).toBe(true);
    const early = await request(app).post(`/api/approvals/${sub.id}/decide`).set(auth(pm.token)).send({ decision: 'APPROVED' });
    expect(early.status).toBe(403);
    const t = await request(app).post(`/api/approvals/${sub.id}/decide`).set(auth(tl.token)).send({ decision: 'APPROVED' });
    expect(t.status).toBe(200);
    expect(t.body.data.currentLevel).toBe('project manager');
    expect(t.body.data.currentApproverId).toBe(pm.id);
    expect(t.body.data.reviewState).toBe('IN_REVIEW');
  });

  it('آخر معتمد (pm) يعتمد → السلسلة تخلص والحالة SENT', async () => {
    const q = await request(app).get('/api/approvals/queue').set(auth(pm.token));
    const sub = q.body.data.find((s: { currentLevel: string }) => s.currentLevel === 'project manager');
    expect(sub.isLast).toBe(true); // آخر مستوى في سلسلة صاحب الكشف
    const p = await request(app).post(`/api/approvals/${sub.id}/decide`).set(auth(pm.token)).send({ decision: 'APPROVED_NOTES', note: 'تمام مع ملاحظة بسيطة' });
    expect(p.status).toBe(200);
    expect(p.body.data.reviewState).toBe('SENT');
    expect(p.body.data.currentLevel).toBeNull();
    expect(p.body.data.reviews.length).toBe(2); // tl + pm
  });

  it('درجة المرسِل بتحدد السلسلة: كشف team leader بيبدأ عند مدير التنفيذ (مفيش مدير فريق فوقه)', async () => {
    await patchUser(admin.token, tl.id, { approverCmId: cm.id });
    const res = await submit(tl.token);
    expect(res.status).toBe(201);
    expect(res.body.data.currentLevel).toBe('construction manager');
    expect(res.body.data.currentApproverId).toBe(cm.id);
    const a = await request(app).post(`/api/approvals/${res.body.data.id}/decide`).set(auth(cm.token)).send({ decision: 'APPROVED' });
    expect(a.body.data.currentLevel).toBe('project manager');
    const b = await request(app).post(`/api/approvals/${res.body.data.id}/decide`).set(auth(pm.token)).send({ decision: 'APPROVED' });
    expect(b.body.data.reviewState).toBe('SENT');
  });

  it('كشف مدير التنفيذ أو مدير المشروع محدش بيعتمده → يتبعت فورًا', async () => {
    const res = await submit(cm.token);
    expect(res.status).toBe(201);
    const fresh = await prisma.submission.findUnique({ where: { id: BigInt(res.body.data.id) } });
    expect(fresh?.reviewState).toBe('SENT');
    expect(fresh?.currentLevel).toBeNull();
  });

  it('الرفض بملاحظة يرجّع الكشف للمهندس (RETURNED)، وإعادة الإرسال تزوّد النسخة وتبدأ السلسلة من أولها', async () => {
    const res = await submit(eng.token);
    const id = res.body.data.id;
    const noNote = await request(app).post(`/api/approvals/${id}/decide`).set(auth(tl.token)).send({ decision: 'REJECTED' });
    expect(noNote.status).toBe(400);
    const rej = await request(app).post(`/api/approvals/${id}/decide`).set(auth(tl.token)).send({ decision: 'REJECTED', note: 'الإجمالي غلط' });
    expect(rej.body.data.reviewState).toBe('RETURNED');

    const mine = (await request(app).get('/api/submissions/mine').set(auth(eng.token))).body.data.find((s: { id: string }) => s.id === id);
    expect(mine.reviewState).toBe('RETURNED');

    const resend = await request(app).post(`/api/submissions/${id}/resend`).set(auth(eng.token)).attach('file', xlsx, 'k2.xlsx');
    expect(resend.status).toBe(200);
    expect(resend.body.data.revision).toBe(1);
    expect(resend.body.data.currentLevel).toBe('team leader');
    expect(resend.body.data.currentApproverId).toBe(tl.id);
    expect(resend.body.data.reviewState).toBe('IN_REVIEW');
  });

  it('المعتمد (مش صاحب الملف ولا أدمن) يقدر يفتح ملف الكشف من مسار الاعتمادات', async () => {
    const res = await submit(eng.token);
    const id = res.body.data.id;
    const viaSubs = await request(app).get(`/api/submissions/${id}/file`).set(auth(tl.token));
    expect([403, 404]).toContain(viaSubs.status);
    const viaApr = await request(app).get(`/api/approvals/${id}/file`).set(auth(tl.token));
    expect(viaApr.status).toBe(200);
    expect(viaApr.headers['content-disposition']).toContain('attachment');
    const denied = await request(app).get(`/api/approvals/${id}/file`).set(auth(eng.token));
    expect(denied.status).toBe(403);
  });

  it('الأدمن يخفي صفًا من الطابور فقط — الكشف يفضل في "تسليماتي" وسجله كامل، وغير الأدمن ممنوع', async () => {
    const res = await submit(eng.token);
    const id = res.body.data.id;
    const early = await request(app).post(`/api/approvals/${id}/hide`).set(auth(admin.token));
    expect(early.status).toBe(400);
    await request(app).post(`/api/approvals/${id}/decide`).set(auth(tl.token)).send({ decision: 'REJECTED', note: 'ملاحظة' });
    const denied = await request(app).post(`/api/approvals/${id}/hide`).set(auth(tl.token));
    expect(denied.status).toBe(403);
    const ok = await request(app).post(`/api/approvals/${id}/hide`).set(auth(admin.token));
    expect(ok.status).toBe(200);
    const q = await request(app).get('/api/approvals/queue').set(auth(admin.token));
    expect(q.body.data.find((s: { id: string }) => s.id === id)).toBeUndefined();
    const mine = (await request(app).get('/api/submissions/mine').set(auth(eng.token))).body.data.find((s: { id: string }) => s.id === id);
    expect(mine).toBeTruthy();
    expect(mine.reviewState).toBe('RETURNED');
    expect(mine.reviews.length).toBe(1);
  });

  it('الوحدة محمية: حساب من غير صلاحية approvals مايوصلش للطابور', async () => {
    const denied = await request(app).get('/api/approvals/queue').set(auth(eng.token));
    expect(denied.status).toBe(403);
  });

  it('المعتمد المسند لازم تكون درجته هي نفس المستوى، والحساب مايعتمدش لنفسه', async () => {
    const wrong = await patchUser(admin.token, eng.id, { approverTlId: cm.id }); // cm مش team leader
    expect(wrong.status).toBe(400);
    const self = await patchUser(admin.token, tl.id, { approverTlId: tl.id });
    expect(self.status).toBe(400);
  });

  it('الدرجة أو الإسناد اتغيّر والكشف واقف عند مستوى خرج من سلسلته: يفضل معلّقًا والأدمن بس يحرّكه', async () => {
    const res = await submit(eng.token);
    const id = res.body.data.id;
    expect(res.body.data.currentLevel).toBe('team leader');

    // الأدمن يشيل إسناد مدير الفريق → المستوى ده خرج من سلسلة eng والكشف لسه واقف عنده
    await patchUser(admin.token, eng.id, { approverTlId: null });

    const q = await request(app).get('/api/approvals/queue').set(auth(admin.token));
    const row = q.body.data.find((s: { id: string }) => s.id === id);
    expect(row.reviewState).toBe('IN_REVIEW');
    expect(row.isStuck).toBe(true);

    // tl لسه مسند عليه الكشف شخصيًا فبيشوفه، لكن الاعتماد مرفوض لأن المستوى خرج من السلسلة
    const tlTry = await request(app).post(`/api/approvals/${id}/decide`).set(auth(tl.token)).send({ decision: 'APPROVED' });
    expect(tlTry.status).toBe(400);
    const still = await prisma.submission.findUnique({ where: { id: BigInt(id) } });
    expect(still?.reviewState).toBe('IN_REVIEW');
    expect(still?.currentLevel).toBe('team leader');

    // الأدمن يفكّه → يكمّل من أول مستوى في السلسلة الحالية (project manager التلقائي)
    const adm = await request(app).post(`/api/approvals/${id}/decide`).set(auth(admin.token)).send({ decision: 'APPROVED' });
    expect(adm.status).toBe(200);
    expect(adm.body.data.reviewState).toBe('IN_REVIEW');
    expect(adm.body.data.currentLevel).toBe('project manager');

    await patchUser(admin.token, eng.id, { approverTlId: tl.id });
  });

  it('لو مفيش معتمدين مضبوطين خالص → الكشف يتبعت فورًا (السلوك القديم)', async () => {
    await patchUser(admin.token, eng.id, { approverTlId: null });
    await patchUser(admin.token, pm.id, { grade: 'senior' }); // مفيش project manager في النظام
    const res = await submit(eng.token);
    expect(res.status).toBe(201);
    const fresh = await prisma.submission.findUnique({ where: { id: BigInt(res.body.data.id) } });
    expect(fresh?.reviewState).toBe('SENT');
    await patchUser(admin.token, pm.id, { grade: 'project manager' });
    await patchUser(admin.token, eng.id, { approverTlId: tl.id });
  });

  it('الأدمن يشوف الدرجات والمصفوفة وقوائم المعتمدين + تحذير المستوى الناقص', async () => {
    const lv = await request(app).get('/api/admin/approval-levels').set(auth(admin.token));
    expect(lv.status).toBe(200);
    expect(lv.body.data.grades).toEqual(['junior', 'senior', 'team leader', 'construction manager', 'project manager']);
    expect(lv.body.data.matrix['team leader']).toEqual(['construction manager', 'project manager']);
    expect(lv.body.data.matrix['project manager']).toEqual([]);
    expect(lv.body.data.approvers.some((a: { email: string }) => a.email === 'tl@test.com')).toBe(true);
    // eng مالوش مدير تنفيذ مسند → بيظهر في تحذير كارت الحساب
    const users = await request(app).get('/api/admin/users').set(auth(admin.token));
    const row = users.body.data.find((u: { email: string }) => u.email === 'eng@test.com');
    expect(row.grade).toBe('junior');
    expect(row.missingApprovers).toContain('construction manager');
    expect(row.missingApprovers).not.toContain('team leader');
  });
});
