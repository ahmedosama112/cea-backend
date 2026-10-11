// (أكتوبر 2026) السينيور يعتمد للجونيور: خطوة اختيارية قبل مدير الفريق بإسناد approverSrId.
// السلسلة نفسها (TL→CM→PM والمصفوفة) مابتتغيرش — ومن غير سينيور مسند الكشف بيبدأ عند مدير الفريق زي الأول.
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';

const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x74, 0x65, 0x73, 0x74]);

async function submit(token: string, projectId?: number) {
  const req = request(app).post('/api/submissions').set(auth(token))
    .field('contractorName', 'مقاول').field('placeName', 'موقع').field('weekStart', '2026-08-12')
    .field('weekEnd', '2026-08-18').field('total', '500').field('recordsCount', '2');
  if (projectId != null) req.field('projectId', String(projectId));
  return req.attach('file', xlsx, 'k.xlsx');
}
async function patchUser(adminToken: string, userId: string, body: Record<string, unknown>) {
  return request(app).patch(`/api/admin/users/${userId}`).set(auth(adminToken)).send(body);
}
async function enableApprovals(adminToken: string, userId: string) {
  return request(app).put(`/api/admin/users/${userId}/settings`).set(auth(adminToken))
    .send({ enabledModules: ['records', 'submissions', 'approvals'] });
}
const decide = (token: string, id: string, decision = 'APPROVED', note = '') =>
  request(app).post(`/api/approvals/${id}/decide`).set(auth(token)).send({ decision, note });

describe('السينيور يعتمد للجونيور قبل مدير الفريق', () => {
  let admin: TestUser, jr: TestUser, jr2: TestUser, sr: TestUser, sr2: TestUser, tl: TestUser, cm: TestUser, pm: TestUser;

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    jr = await createEngineer(admin.token, 'jr@test.com');
    jr2 = await createEngineer(admin.token, 'jr2@test.com');
    sr = await createEngineer(admin.token, 'sr@test.com');
    sr2 = await createEngineer(admin.token, 'sr2@test.com');
    tl = await createEngineer(admin.token, 'tl@test.com');
    cm = await createEngineer(admin.token, 'cm@test.com');
    pm = await createEngineer(admin.token, 'pm@test.com');
    await patchUser(admin.token, tl.id, { grade: 'team leader' });
    await patchUser(admin.token, cm.id, { grade: 'construction manager' });
    await patchUser(admin.token, pm.id, { grade: 'project manager' });
    await patchUser(admin.token, sr.id, { grade: 'senior', approverTlId: tl.id, approverCmId: cm.id });
    await patchUser(admin.token, sr2.id, { grade: 'senior' });
    // jr: سينيور مسند + نفس سلسلته القديمة · jr2: نفس السلسلة من غير سينيور
    await patchUser(admin.token, jr.id, { approverSrId: sr.id, approverTlId: tl.id, approverCmId: cm.id });
    await patchUser(admin.token, jr2.id, { approverTlId: tl.id, approverCmId: cm.id });
    for (const u of [sr, sr2, tl, cm, pm]) await enableApprovals(admin.token, u.id);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('الإسناد: لازم درجة المختار senior، ومايتسندش لنفسه', async () => {
    const bad = await patchUser(admin.token, jr.id, { approverSrId: tl.id });
    expect(bad.status).toBe(400);
    const self = await patchUser(admin.token, sr.id, { approverSrId: sr.id });
    expect(self.status).toBe(400);
    const users = (await request(app).get('/api/admin/users').set(auth(admin.token))).body.data;
    const row = users.find((u: { email: string }) => u.email === 'jr@test.com');
    expect(row.approverSrId).toBe(sr.id);
    // السينيور خطوة اختيارية — مش بيظهر في تحذير "معتمد ناقص"
    expect(users.find((u: { email: string }) => u.email === 'jr2@test.com').missingApprovers).not.toContain('senior');
    const lv = (await request(app).get('/api/admin/approval-levels').set(auth(admin.token))).body.data;
    expect(lv.seniorLevel).toBe('senior');
    expect(lv.approvers.some((a: { email: string }) => a.email === 'sr@test.com')).toBe(true);
    // المصفوفة زي ما هي
    expect(lv.matrix.junior).toEqual(['team leader', 'construction manager', 'project manager']);
  });

  it('كشف الجونيور: سينيور ← مدير فريق ← مدير تنفيذ ← مدير مشروع، وكل واحد في دوره بس', async () => {
    const res = await submit(jr.token);
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    expect(res.body.data.currentLevel).toBe('senior');
    expect(res.body.data.currentApproverId).toBe(sr.id);

    // الطابور: السينيور دوره، والسلسلة فيها خطوته أولها باسمه
    const q = (await request(app).get('/api/approvals/queue').set(auth(sr.token))).body;
    expect(q.activeLevels).toEqual(['senior', 'team leader', 'construction manager', 'project manager']);
    expect(q.viewer).toBe(false);
    const row = q.data.find((s: { id: string }) => s.id === id);
    expect(row.canAct).toBe(true);
    expect(row.chain).toEqual(['senior', 'team leader', 'construction manager', 'project manager']);
    expect(row.approverNames.senior).toBe('sr');
    // السينيور يفتح ملف الكشف للمراجعة
    expect((await request(app).get(`/api/approvals/${id}/file`).set(auth(sr.token))).status).toBe(200);

    // مدير الفريق وسينيور تاني مش دورهم لسه
    expect((await decide(tl.token, id)).status).toBe(403);
    expect((await decide(sr2.token, id)).status).toBe(403);

    const a = await decide(sr.token, id);
    expect(a.status).toBe(200);
    expect(a.body.data.currentLevel).toBe('team leader');
    expect(a.body.data.currentApproverId).toBe(tl.id);
    expect((await decide(tl.token, id)).body.data.currentLevel).toBe('construction manager');
    expect((await decide(cm.token, id)).body.data.currentLevel).toBe('project manager');
    const done = await decide(pm.token, id);
    expect(done.body.data.reviewState).toBe('SENT');
    const levels = (await prisma.submissionReview.findMany({ where: { submissionId: BigInt(id) }, orderBy: { id: 'asc' } })).map((r) => r.level);
    expect(levels).toEqual(['senior', 'team leader', 'construction manager', 'project manager']);
  });

  it('السينيور يرفض → الكشف يرجع للجونيور', async () => {
    const id = (await submit(jr.token)).body.data.id;
    const r = await decide(sr.token, id, 'REJECTED', 'راجع الأيام');
    expect(r.status).toBe(200);
    expect(r.body.data.reviewState).toBe('RETURNED');
  });

  it('جونيور من غير سينيور مسند: السلسلة القديمة بالظبط (تبدأ عند مدير الفريق)', async () => {
    const res = await submit(jr2.token);
    expect(res.body.data.currentLevel).toBe('team leader');
    const row = (await request(app).get('/api/approvals/queue').set(auth(tl.token))).body.data.find((s: { id: string }) => s.id === res.body.data.id);
    expect(row.chain).toEqual(['team leader', 'construction manager', 'project manager']);
  });

  it('كشف السينيور نفسه مالوش خطوة سينيور حتى لو مسند له واحد', async () => {
    await prisma.user.update({ where: { id: BigInt(sr.id) }, data: { approverSrId: BigInt(sr2.id) } });
    const res = await submit(sr.token);
    expect(res.body.data.currentLevel).toBe('team leader');
    await prisma.user.update({ where: { id: BigInt(sr.id) }, data: { approverSrId: null } });
  });

  it('معتمدو المشروع: السينيور بيتنسخ عند أول تحميل للمشروع وبيتغيّر لكل مشروع لوحده', async () => {
    const put = await request(app).put(`/api/admin/users/${jr.id}/projects/2`).set(auth(admin.token)).send({});
    expect(put.status).toBe(200);
    expect(put.body.data.approverSrId).toBe(sr.id);
    const changed = await request(app).put(`/api/admin/users/${jr.id}/projects/2`).set(auth(admin.token)).send({ approverSrId: sr2.id });
    expect(changed.body.data.approverSrId).toBe(sr2.id);
    const bad = await request(app).put(`/api/admin/users/${jr.id}/projects/2`).set(auth(admin.token)).send({ approverSrId: cm.id });
    expect(bad.status).toBe(400);

    await request(app).post(`/api/admin/users/${jr.id}/places`).set(auth(admin.token)).send({ name: 'موقع', site: 2 });
    const res = await submit(jr.token, 2);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.currentLevel).toBe('senior');
    expect(res.body.data.currentApproverId).toBe(sr2.id);
    // شيل السينيور من المشروع → الكشوف الجاية تبدأ عند مدير الفريق
    await request(app).put(`/api/admin/users/${jr.id}/projects/2`).set(auth(admin.token)).send({ approverSrId: null });
    const res2 = await submit(jr.token, 2);
    expect(res2.body.data.currentLevel).toBe('team leader');
  });
});
