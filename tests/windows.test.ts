import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';
import { cairoParts, evaluate, sanitizeConfig, WindowConfig } from '../src/services/windows';

// نافذة المثال: التلات 8ص → الأربع 5م (بتوقيت القاهرة)
const WIN: WindowConfig = {
  enabled: true,
  windows: [{ from: { day: 2, time: '08:00' }, to: { day: 3, time: '17:00' } }],
  openUntil: null,
};
// لحظة UTC توافق يوم/ساعة معيّنة بتوقيت القاهرة — بنتأكد من التحويل نفسه في كل حالة
const at = (iso: string) => new Date(iso);

describe('نوافذ الإرسال والاعتماد — الحساب', () => {
  it('cairoParts بتحوّل UTC لتوقيت القاهرة صح صيفًا وشتاءً', () => {
    // 9 سبتمبر 2026 = توقيت صيفي (+3): 14:30 UTC = 17:30 بالقاهرة، والأربع = يوم 3
    const summer = cairoParts(at('2026-09-09T14:30:00Z'));
    expect(summer.day).toBe(3);
    expect(summer.minutes).toBe(17 * 60 + 30);
    // 9 ديسمبر 2026 = توقيت شتوي (+2): 14:30 UTC = 16:30 بالقاهرة
    const winter = cairoParts(at('2026-12-09T14:30:00Z'));
    expect(winter.day).toBe(3);
    expect(winter.minutes).toBe(16 * 60 + 30);
  });

  it('مفتوحة جوّه النافذة ومقفولة برّاها', () => {
    // التلات 8 سبتمبر 2026، 09:00 بالقاهرة (06:00Z صيفي) → جوّه
    expect(evaluate('submit', WIN, at('2026-09-08T06:00:00Z')).open).toBe(true);
    // الأربع 9 سبتمبر، 16:59 بالقاهرة (13:59Z) → لسه جوّه
    expect(evaluate('submit', WIN, at('2026-09-09T13:59:00Z')).open).toBe(true);
    // الأربع 9 سبتمبر، 17:00 بالقاهرة (14:00Z) → قفلت بالظبط
    expect(evaluate('submit', WIN, at('2026-09-09T14:00:00Z')).open).toBe(false);
    // التلات 8 سبتمبر، 07:59 بالقاهرة (04:59Z) → لسه ما فتحتش
    expect(evaluate('submit', WIN, at('2026-09-08T04:59:00Z')).open).toBe(false);
    // الجمعة → برّاها
    expect(evaluate('submit', WIN, at('2026-09-11T09:00:00Z')).open).toBe(false);
  });

  it('التوقيت الصيفي ما يزحلقش النافذة — نفس ساعة الحائط في الشتا', () => {
    // 8 ديسمبر 2026 = تلات، شتوي (+2). 16:59 بالقاهرة = 14:59Z … و17:00 = 15:00Z
    const winterWin = evaluate('submit', WIN, at('2026-12-09T14:59:00Z')); // أربع 16:59 بالقاهرة
    expect(winterWin.open).toBe(true);
    const winterClosed = evaluate('submit', WIN, at('2026-12-09T15:00:00Z')); // أربع 17:00 بالقاهرة
    expect(winterClosed.open).toBe(false);
  });

  it('النافذة اللي بتلفّ حوالين الأسبوع (الخميس → الاتنين)', () => {
    const wrap: WindowConfig = { enabled: true, windows: [{ from: { day: 4, time: '18:00' }, to: { day: 1, time: '09:00' } }], openUntil: null };
    expect(evaluate('submit', wrap, at('2026-09-11T09:00:00Z')).open).toBe(true);  // جمعة 12:00 بالقاهرة
    expect(evaluate('submit', wrap, at('2026-09-13T09:00:00Z')).open).toBe(true);  // أحد 12:00
    expect(evaluate('submit', wrap, at('2026-09-14T05:00:00Z')).open).toBe(true);  // اتنين 08:00
    expect(evaluate('submit', wrap, at('2026-09-14T07:00:00Z')).open).toBe(false); // اتنين 10:00 — قفلت
    expect(evaluate('submit', wrap, at('2026-09-09T09:00:00Z')).open).toBe(false); // أربع — برّاها
  });

  it('متعطّلة = مفتوحة على طول (السلوك القديم)', () => {
    const off = { ...WIN, enabled: false };
    expect(evaluate('submit', off, at('2026-09-11T09:00:00Z')).open).toBe(true);
    expect(evaluate('submit', off, at('2026-09-11T09:00:00Z')).nextChangeAt).toBeNull();
  });

  it('الفتح الاستثنائي بيفتح لحد ميعاده وبعده بيرجع يقفل', () => {
    const now = at('2026-09-11T09:00:00Z'); // جمعة — برّه النافذة
    const withOverride = { ...WIN, openUntil: '2026-09-11T11:00:00.000Z' };
    const during = evaluate('submit', withOverride, now);
    expect(during.open).toBe(true);
    expect(during.overrideOpen).toBe(true);
    const after = evaluate('submit', withOverride, at('2026-09-11T11:00:01Z'));
    expect(after.open).toBe(false);
  });

  it('nextChangeAt: بيقفل صح وهي مفتوحة، وبيفتح صح وهي مقفولة', () => {
    // أربع 9 سبتمبر 13:00Z (16:00 بالقاهرة) → مفتوحة، بتقفل الساعة 17:00 بالقاهرة = 14:00Z
    const open = evaluate('submit', WIN, at('2026-09-09T13:00:00Z'));
    expect(open.open).toBe(true);
    expect(open.nextChangeAt).toBe('2026-09-09T14:00:00.000Z');
    // جمعة 11 سبتمبر → مقفولة، بتفتح التلات الجاي 15 سبتمبر 08:00 بالقاهرة = 05:00Z
    const closed = evaluate('submit', WIN, at('2026-09-11T09:00:00Z'));
    expect(closed.open).toBe(false);
    expect(closed.nextChangeAt).toBe('2026-09-15T05:00:00.000Z');
  });

  it('nextChangeAt بيعدّي تغيير التوقيت الصيفي من غير انزياح ساعة', () => {
    // التوقيت الصيفي في مصر بينتهي آخر جمعة في أكتوبر (30 أكتوبر 2026).
    // من الأربع 28 أكتوبر (صيفي) لحد التلات 3 نوفمبر (شتوي) لازم تفضل 08:00 بالقاهرة = 06:00Z
    const closed = evaluate('submit', WIN, at('2026-10-28T15:00:00Z')); // أربع بعد القفل
    expect(closed.open).toBe(false);
    const opensAt = new Date(closed.nextChangeAt!);
    expect(cairoParts(opensAt).day).toBe(2);
    expect(cairoParts(opensAt).minutes).toBe(8 * 60);
  });

  it('sanitizeConfig بترفض القيم الغلط وترجّع الافتراضي', () => {
    const bad = sanitizeConfig({ enabled: true, windows: [{ from: { day: 99, time: '99:99' }, to: { day: -3, time: 'abc' } }] }, 'submit');
    expect(bad.windows[0].from.day).toBe(2);
    expect(bad.windows[0].from.time).toBe('08:00');
    expect(sanitizeConfig(null, 'submit').enabled).toBe(false);
    expect(sanitizeConfig({ enabled: true, openUntil: 'مش تاريخ' }, 'submit').openUntil).toBeNull();
  });
});

describe('نوافذ الإرسال والاعتماد — المسارات', () => {
  let admin: TestUser;
  let eng: TestUser;

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    eng = await createEngineer(admin.token);
  });
  afterAll(async () => {
    await prisma.appConfig.deleteMany({ where: { key: { in: ['submitWindow', 'approveWindow'] } } });
    await prisma.$disconnect();
  });

  it('GET /api/windows متاح لأي حساب مسجّل وبيرجّع وقت السيرفر', async () => {
    const r = await request(app).get('/api/windows').set(auth(eng.token));
    expect(r.status).toBe(200);
    expect(r.body.data.submit.open).toBe(true); // متعطّلة افتراضيًا
    expect(typeof r.body.serverNow).toBe('string');
  });

  it('PATCH /api/admin/windows للأدمن فقط', async () => {
    const denied = await request(app).patch('/api/admin/windows').set(auth(eng.token)).send({ submit: { enabled: true, windows: WIN.windows } });
    expect(denied.status).toBe(403);
    const ok = await request(app).patch('/api/admin/windows').set(auth(admin.token)).send({ submit: { enabled: true, windows: WIN.windows } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.submit.enabled).toBe(true);
  });

  it('الإرسال مرفوض برّه الميعاد — والأدمن مستثنى', async () => {
    // نقفل النافذة تمامًا: نافذة دقيقة واحدة يوم الجمعة الساعة 3 الفجر
    await request(app).patch('/api/admin/windows').set(auth(admin.token))
      .send({ submit: { enabled: true, windows: [{ from: { day: 5, time: '03:00' }, to: { day: 5, time: '03:01' } }] } });

    const st = await request(app).get('/api/windows').set(auth(eng.token));
    if (st.body.data.submit.open) return; // لو الاختبار اتشغّل في الدقيقة دي بالظبط — نتخطى

    const blocked = await request(app).post('/api/submissions').set(auth(eng.token))
      .field('contractorName', 'مقاول').field('weekStart', '2026-09-01').field('weekEnd', '2026-09-07')
      .field('total', '100').field('recordsCount', '1')
      .attach('file', Buffer.from('PKtest'), 'x.xlsx');
    expect(blocked.status).toBe(400);
    expect(String(blocked.body.message || blocked.body.error?.message || '')).toContain('مقفول');

    // الأدمن بيعدّي الحارس (بيفشل بعد كده لسبب تاني — المهم إنه مش مرفوض بسبب الميعاد)
    const adminTry = await request(app).post('/api/submissions').set(auth(admin.token))
      .field('contractorName', 'مقاول').field('weekStart', '2026-09-01').field('weekEnd', '2026-09-07')
      .field('total', '100').field('recordsCount', '1')
      .attach('file', Buffer.from('not-a-zip'), 'x.xlsx');
    expect(String(adminTry.body.message || adminTry.body.error?.message || '')).not.toContain('مقفول');
  });

  it('الفتح الاستثنائي بيسمح بالإرسال وهو برّه الميعاد', async () => {
    await request(app).patch('/api/admin/windows').set(auth(admin.token)).send({
      submit: {
        enabled: true,
        windows: [{ from: { day: 5, time: '03:00' }, to: { day: 5, time: '03:01' } }],
        openUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    const st = await request(app).get('/api/windows').set(auth(eng.token));
    expect(st.body.data.submit.open).toBe(true);
    expect(st.body.data.submit.overrideOpen).toBe(true);
  });
});
