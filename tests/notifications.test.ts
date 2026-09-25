import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';

// التنبيهات الداخلية — الأدمن بيكتب التنبيه ومواعيده ومستقبليه، وكل حساب بيقرا اللي موجّه له بس

const weekly = {
  title: 'إرسال السراكي للاعتماد',
  body: 'كل ثلاثاء قبل نهاية اليوم',
  icon: '📤',
  level: 'warn',
  schedule: 'weekly',
  weekdays: [2],
  timeOfDay: '09:00',
  leadDays: 1,
  audience: 'all',
  linkTab: 'submissions',
};

describe('Notifications (التنبيهات الداخلية)', () => {
  let admin: TestUser;
  let eng: TestUser;
  let eng2: TestUser;

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    eng = await createEngineer(admin.token, 'notif-eng@test.com');
    eng2 = await createEngineer(admin.token, 'notif-eng2@test.com');
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('المهندس ما يقدرش يضيف تنبيه ولا يشوف شاشة الإدارة', async () => {
    const post = await request(app).post('/api/notifications/manage').set(auth(eng.token)).send(weekly);
    expect(post.status).toBe(403);
    const list = await request(app).get('/api/notifications/manage').set(auth(eng.token));
    expect(list.status).toBe(403);
  });

  let allId: string;
  it('الأدمن بيضيف تنبيه أسبوعي للكل', async () => {
    const res = await request(app).post('/api/notifications/manage').set(auth(admin.token)).send(weekly);
    expect(res.status).toBe(201);
    expect(res.body.data.weekdays).toEqual([2]);
    expect(res.body.data.leadDays).toBe(1);
    expect(res.body.data.audience).toBe('all');
    allId = res.body.data.id;
  });

  it('جدولة ناقصة بترفض: أسبوعي بلا أيام، وشهري بلا يوم، ومستقبلين بلا حسابات', async () => {
    const a = await request(app).post('/api/notifications/manage').set(auth(admin.token)).send({ ...weekly, weekdays: [] });
    expect(a.status).toBe(400);
    const b = await request(app).post('/api/notifications/manage').set(auth(admin.token)).send({ ...weekly, schedule: 'monthly', monthDay: null });
    expect(b.status).toBe(400);
    const c = await request(app).post('/api/notifications/manage').set(auth(admin.token)).send({ ...weekly, audience: 'users', userIds: [] });
    expect(c.status).toBe(400);
  });

  let mineId: string;
  let pickedId: string;
  it('تنبيه "أنا بس" بيوصل للأدمن لوحده، وتنبيه بحسابات مختارة بيوصل للمختار بس', async () => {
    const mine = await request(app).post('/api/notifications/manage').set(auth(admin.token))
      .send({ title: 'تذكير شخصي', schedule: 'daily', audience: 'me' });
    expect(mine.status).toBe(201);
    mineId = mine.body.data.id;

    const picked = await request(app).post('/api/notifications/manage').set(auth(admin.token))
      .send({ title: 'راجع كشف المعدات', schedule: 'monthly', monthDay: 19, audience: 'users', userIds: [eng.id] });
    expect(picked.status).toBe(201);
    expect(picked.body.data.userIds).toEqual([String(eng.id)]);
    pickedId = picked.body.data.id;

    const forEng = await request(app).get('/api/notifications').set(auth(eng.token));
    const ids = forEng.body.data.notifications.map((n: { id: string }) => n.id);
    expect(ids).toContain(allId);
    expect(ids).toContain(pickedId);
    expect(ids).not.toContain(mineId);

    const forEng2 = await request(app).get('/api/notifications').set(auth(eng2.token));
    const ids2 = forEng2.body.data.notifications.map((n: { id: string }) => n.id);
    expect(ids2).toEqual([allId]);

    const forAdmin = await request(app).get('/api/notifications').set(auth(admin.token));
    expect(forAdmin.body.data.notifications.map((n: { id: string }) => n.id)).toContain(mineId);
  });

  it('المستقبلون بالدرجة: بيوصل لصاحب الدرجة بس', async () => {
    await request(app).patch(`/api/admin/users/${eng2.id}`).set(auth(admin.token)).send({ grade: 'team leader' });
    const res = await request(app).post('/api/notifications/manage').set(auth(admin.token))
      .send({ title: 'اجتماع مديري الفرق', schedule: 'weekly', weekdays: [0], audience: 'grade', audienceGrade: 'team leader' });
    expect(res.status).toBe(201);
    const gid = res.body.data.id;
    const forEng2 = await request(app).get('/api/notifications').set(auth(eng2.token));
    expect(forEng2.body.data.notifications.map((n: { id: string }) => n.id)).toContain(gid);
    const forEng = await request(app).get('/api/notifications').set(auth(eng.token));
    expect(forEng.body.data.notifications.map((n: { id: string }) => n.id)).not.toContain(gid);
  });

  it('"تم" على ظهور بعينه بيترجع في قائمتي، والتراجع بيشيله', async () => {
    const done = await request(app).post(`/api/notifications/${allId}/done`).set(auth(eng.token)).send({ occurrence: '2026-09-08' });
    expect(done.status).toBe(200);
    const mine = await request(app).get('/api/notifications').set(auth(eng.token));
    const n = mine.body.data.notifications.find((x: { id: string }) => x.id === allId);
    expect(n.done).toEqual(['2026-09-08']);
    // نفس الظهور مرتين = صف واحد (upsert) — ومش بيأثر على حساب تاني
    await request(app).post(`/api/notifications/${allId}/done`).set(auth(eng.token)).send({ occurrence: '2026-09-08' });
    expect(await prisma.notificationRead.count()).toBe(1);
    const other = await request(app).get('/api/notifications').set(auth(eng2.token));
    expect(other.body.data.notifications.find((x: { id: string }) => x.id === allId).done).toEqual([]);

    const undo = await request(app).post(`/api/notifications/${allId}/undone`).set(auth(eng.token)).send({ occurrence: '2026-09-08' });
    expect(undo.status).toBe(200);
    expect(await prisma.notificationRead.count()).toBe(0);
  });

  it('التعديل الجزئي بيسيب باقي الحقول زي ما هي، وتبديل نوع الجدولة بيفضّي حقول النوع القديم', async () => {
    const off = await request(app).patch(`/api/notifications/manage/${allId}`).set(auth(admin.token)).send({ active: false });
    expect(off.status).toBe(200);
    expect(off.body.data.weekdays).toEqual([2]);
    expect(off.body.data.title).toBe(weekly.title);
    expect(off.body.data.active).toBe(false);
    // موقوف = ما بيوصلش لحد
    const forEng = await request(app).get('/api/notifications').set(auth(eng.token));
    expect(forEng.body.data.notifications.map((n: { id: string }) => n.id)).not.toContain(allId);

    const toOnce = await request(app).patch(`/api/notifications/manage/${allId}`).set(auth(admin.token))
      .send({ active: true, schedule: 'once', onceDate: '2026-10-01' });
    expect(toOnce.status).toBe(200);
    expect(toOnce.body.data.weekdays).toEqual([]);
    expect(toOnce.body.data.onceDate).toBe('2026-10-01');
  });

  it('تنبيه انتهت مدته ما بيتبعتش للأجهزة', async () => {
    const res = await request(app).post('/api/notifications/manage').set(auth(admin.token))
      .send({ title: 'تنبيه قديم', schedule: 'daily', audience: 'all', endDate: '2020-01-01' });
    expect(res.status).toBe(201);
    const forEng = await request(app).get('/api/notifications').set(auth(eng.token));
    expect(forEng.body.data.notifications.map((n: { id: string }) => n.id)).not.toContain(res.body.data.id);
    // بس بيفضل ظاهر للأدمن في شاشة الإدارة
    const manage = await request(app).get('/api/notifications/manage').set(auth(admin.token));
    expect(manage.body.data.map((n: { id: string }) => n.id)).toContain(res.body.data.id);
  });

  it('الحذف بيشيل التنبيه ومستقبليه', async () => {
    const del = await request(app).delete(`/api/notifications/manage/${pickedId}`).set(auth(admin.token));
    expect(del.status).toBe(200);
    expect(await prisma.notificationTarget.count({ where: { notificationId: BigInt(pickedId) } })).toBe(0);
    const again = await request(app).delete(`/api/notifications/manage/${pickedId}`).set(auth(admin.token));
    expect(again.status).toBe(404);
    const forEng = await request(app).get('/api/notifications').set(auth(eng.token));
    expect(forEng.body.data.notifications.map((n: { id: string }) => n.id)).not.toContain(pickedId);
  });

  it('التنبيهات التلقائية: كشف مرفوض بيرجع في auto.rejected لصاحبه بس', async () => {
    const file = await prisma.file.create({
      data: { userId: BigInt(eng.id), fileName: 'k.xlsx', filePath: 'x/k.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileSize: 10 },
    });
    await prisma.submission.create({
      data: {
        userId: BigInt(eng.id), fileId: file.id, contractorName: 'مقاول تجريبي', weekStart: new Date('2026-09-01'),
        weekEnd: new Date('2026-09-07'), total: 100, recordsCount: 1, reviewState: 'RETURNED',
      },
    });
    // المهندس لازم يكون عنده وحدة التسليمات (مفعّلة افتراضيًا) عشان التنبيه يتحسب
    const mine = await request(app).get('/api/notifications').set(auth(eng.token));
    expect(mine.body.data.auto.rejected.count).toBe(1);
    expect(mine.body.data.auto.rejected.items[0].contractorName).toBe('مقاول تجريبي');
    expect(mine.body.data.auto.rejected.items[0].revision).toBe(0);
    const other = await request(app).get('/api/notifications').set(auth(eng2.token));
    expect(other.body.data.auto.rejected).toBeUndefined();
  });

  it('التنبيهات التلقائية: auto.approvals بيرجّع بصمة لكل كشف مستحق (id:revision:level)', async () => {
    const file = await prisma.file.create({
      data: { userId: BigInt(eng.id), fileName: 'a.xlsx', filePath: 'x/a.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileSize: 10 },
    });
    const sub = await prisma.submission.create({
      data: {
        userId: BigInt(eng.id), fileId: file.id, contractorName: 'مقاول اعتماد', weekStart: new Date('2026-09-08'),
        weekEnd: new Date('2026-09-14'), total: 50, recordsCount: 1, reviewState: 'IN_REVIEW',
        revision: 2, currentLevel: 'manager', currentApproverId: BigInt(admin.id),
      },
    });
    const res = await request(app).get('/api/notifications').set(auth(admin.token));
    expect(res.body.data.auto.approvals.count).toBe(1);
    expect(res.body.data.auto.approvals.keys).toEqual([`${sub.id}:2:manager`]);
    const other = await request(app).get('/api/notifications').set(auth(eng2.token));
    expect(other.body.data.auto.approvals).toBeUndefined();
  });
});
