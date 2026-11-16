// مشروع "بدون اعتماد": أي كشف عليه يروح الشيت على طول — حتى مع وجود مدير مشروع وحيد (الإسناد التلقائي)
// ومع معتمدين مسندين للحساب؛ ونفس المهندس على مشروع عادي بيعدّي على السلسلة زي الأول.
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';

const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x74, 0x65, 0x73, 0x74]);

describe('مشروع بدون اعتماد', () => {
  let admin: TestUser; let eng: TestUser; let tl: TestUser; let pm: TestUser;

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    eng = await createEngineer(admin.token, 'eng@test.com');
    tl = await createEngineer(admin.token, 'tl@test.com');
    pm = await createEngineer(admin.token, 'pm@test.com');
    await request(app).patch(`/api/admin/users/${tl.id}`).set(auth(admin.token)).send({ grade: 'team leader' });
    await request(app).patch(`/api/admin/users/${pm.id}`).set(auth(admin.token)).send({ grade: 'project manager' });
    await request(app).patch(`/api/admin/users/${eng.id}`).set(auth(admin.token)).send({ grade: 'junior', approverTlId: tl.id });
    await request(app).put(`/api/admin/users/${eng.id}/settings`).set(auth(admin.token)).send({ enabledModules: ['records', 'submissions'] });
    await request(app).put(`/api/admin/users/${tl.id}/settings`).set(auth(admin.token)).send({ enabledModules: ['approvals'] });
    await request(app).put(`/api/admin/users/${eng.id}/projects/1`).set(auth(admin.token)).send({ approverTlId: tl.id });
    await request(app).put(`/api/admin/users/${eng.id}/projects/2`).set(auth(admin.token)).send({ approverTlId: tl.id });
    await request(app).post(`/api/admin/users/${eng.id}/places`).set(auth(admin.token)).send({ name: 'مكان ١', site: 1 });
    await request(app).post(`/api/admin/users/${eng.id}/places`).set(auth(admin.token)).send({ name: 'مكان ٢', site: 2 });
  });

  afterAll(async () => { await prisma.$disconnect(); });

  async function submit(projectId: number, placeName: string) {
    const res = await request(app).post('/api/submissions').set(auth(eng.token))
      .field('contractorName', 'مقاول').field('placeName', placeName)
      .field('weekStart', '2026-08-12').field('weekEnd', '2026-08-18')
      .field('total', '500').field('recordsCount', '2')
      .field('projectId', String(projectId))
      .attach('file', xlsx, 'k.xlsx');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return prisma.submission.findFirstOrThrow({ orderBy: { id: 'desc' } });
  }

  it('كشف قبل التفعيل بيعدّي على السلسلة، وبعد التفعيل بيبان معلّق بسلسلة فاضية', async () => {
    const before = await submit(2, 'مكان ٢');
    expect(before.reviewState).toBe('IN_REVIEW');
    expect(String(before.currentApproverId)).toBe(String(tl.id));

    const g = await request(app).get('/api/admin/projects').set(auth(admin.token));
    expect(g.body.data.find((p: { id: number }) => p.id === 2)).toMatchObject({ noApproval: false, inReview: 1 });

    const on = await request(app).patch('/api/admin/projects/2').set(auth(admin.token)).send({ noApproval: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.data.noApproval).toBe(true);

    const q = await request(app).get('/api/approvals/queue').set(auth(admin.token));
    const row = q.body.data.find((r: { id: string }) => String(r.id) === String(before.id));
    expect(row.chain).toEqual([]);
    expect(row.isStuck).toBe(true);

    // الأدمن بيحرّكه → يروح الشيت
    const d = await request(app).post(`/api/approvals/${before.id}/decide`).set(auth(admin.token)).send({ decision: 'APPROVED' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect((await prisma.submission.findUniqueOrThrow({ where: { id: before.id } })).reviewState).toBe('SENT');
  });

  it('كشف جديد على المشروع ده يروح الشيت على طول (حتى مع مدير مشروع وحيد)', async () => {
    const s = await submit(2, 'مكان ٢');
    expect(s.reviewState).toBe('SENT');
    expect(s.currentLevel).toBeNull();
    expect(s.currentApproverId).toBeNull();
  });

  // (أمان — فحص نوفمبر 2026) projectId جاي من العميل: مهندس مش محمّل عليه المشروع ومالوش أماكن فيه
  // مايقدرش يختار مشروع noApproval عشان يتخطى سلسلة الاعتماد بتاعته
  it('مهندس مش بتاع مشروع noApproval مايقدرش يبعت عليه ويتخطى السلسلة', async () => {
    const other = await createEngineer(admin.token, 'other@test.com');
    await request(app).patch(`/api/admin/users/${other.id}`).set(auth(admin.token)).send({ grade: 'junior', approverTlId: tl.id });
    await request(app).put(`/api/admin/users/${other.id}/settings`).set(auth(admin.token)).send({ enabledModules: ['records', 'submissions'] });
    await request(app).post(`/api/admin/users/${other.id}/places`).set(auth(admin.token)).send({ name: 'مكان آخر', site: 1 });
    const send = (projectId: number) => request(app).post('/api/submissions').set(auth(other.token))
      .field('contractorName', 'مقاول').field('placeName', 'مكان آخر')
      .field('weekStart', '2026-08-12').field('weekEnd', '2026-08-18')
      .field('total', '500').field('recordsCount', '2')
      .field('projectId', String(projectId))
      .attach('file', xlsx, 'k.xlsx');
    const before = await prisma.submission.count();
    const bad = await send(2);
    expect(bad.status, JSON.stringify(bad.body)).toBe(403);
    expect(await prisma.submission.count()).toBe(before);
    const ok = await send(1);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const s = await prisma.submission.findFirstOrThrow({ orderBy: { id: 'desc' } });
    expect(s.reviewState).toBe('IN_REVIEW');
    expect(String(s.currentApproverId)).toBe(String(tl.id));
  });

  it('نفس المهندس على مشروع عادي بيعدّي على السلسلة', async () => {
    const s = await submit(1, 'مكان ١');
    expect(s.reviewState).toBe('IN_REVIEW');
    expect(String(s.currentApproverId)).toBe(String(tl.id));
  });

  it('الإيقاف بيرجّع السلسلة، وتعديل الاسم لوحده ما بيلمسش العلامة', async () => {
    await request(app).patch('/api/admin/projects/2').set(auth(admin.token)).send({ noApproval: false });
    const s = await submit(2, 'مكان ٢');
    expect(s.reviewState).toBe('IN_REVIEW');

    await request(app).patch('/api/admin/projects/2').set(auth(admin.token)).send({ noApproval: true });
    const r = await request(app).patch('/api/admin/projects/2').set(auth(admin.token)).send({ name: 'أزاليا جديد' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ name: 'أزاليا جديد', noApproval: true });
  });

  it('طلب فاضي مرفوض، وغير الأدمن ممنوع', async () => {
    expect((await request(app).patch('/api/admin/projects/2').set(auth(admin.token)).send({})).status).toBe(400);
    expect((await request(app).patch('/api/admin/projects/2').set(auth(eng.token)).send({ noApproval: false })).status).toBe(403);
  });
});
