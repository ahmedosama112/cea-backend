import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';
import { minutesBetween } from '../src/schema/entities.schema';

// سركي المعدات — وحدة `equipment` (إيجار معدات شهري 20→19): سطر لكل يوم تشغيل، المدة من السيرفر

const base = {
  date: '2026-09-06',
  day: 'الأحد',
  contractor: 'محمد عبد الله للمعدات',
  equipment: 'لودر كاتربيلر 950',
  place: 'عمارة 27',
  timeFrom: '07:30',
  timeTo: '16:00',
  works: 'حفر أساسات + نقل ناتج الحفر',
  notes: '',
};

describe('Equipment records (سركي المعدات)', () => {
  let admin: TestUser;
  let eng: TestUser;

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    eng = await createEngineer(admin.token);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('حساب المدة: عادي + وردية بتعدّي نص الليل', () => {
    expect(minutesBetween('07:30', '16:00')).toBe(510);
    expect(minutesBetween('22:00', '06:00')).toBe(480);
    expect(minutesBetween('08:00', '08:00')).toBe(0);
  });

  it('الوحدة مش مفعّلة للمهندس افتراضيًا → 403 (الأدمن مستثنى)', async () => {
    const r1 = await request(app).get('/api/equipment-records').set(auth(eng.token));
    expect(r1.status).toBe(403);
    const r2 = await request(app).get('/api/equipment-records').set(auth(admin.token));
    expect(r2.status).toBe(200);
  });

  let id: string;
  it('الإنشاء بيحسب minutes على السيرفر ويتجاهل أي قيمة مُرسلة', async () => {
    const res = await request(app).post('/api/equipment-records').set(auth(admin.token)).send({ ...base, minutes: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data.minutes).toBe(510);
    expect(res.body.data.equipment).toBe(base.equipment);
    id = res.body.data.id;
  });

  it('بالخصم على + ملاحظة الخصم بيتحفظوا ويرجعوا كمصفوفة', async () => {
    const res = await request(app).post('/api/equipment-records').set(auth(admin.token))
      .send({ ...base, deductOn: ['حمدي صديق', 'عطا محمد'], deductNote: 'سلفة' });
    expect(res.status).toBe(201);
    expect(res.body.data.deductOn).toEqual(['حمدي صديق', 'عطا محمد']);
    expect(res.body.data.deductNote).toBe('سلفة');
    const bad = await request(app).post('/api/equipment-records').set(auth(admin.token)).send({ ...base, deductOn: 'x' });
    expect(bad.status).toBe(400);
    await request(app).delete(`/api/equipment-records/${res.body.data.id}`).set(auth(admin.token));
  });

  it('التعديل يعيد حساب المدة', async () => {
    const res = await request(app).put(`/api/equipment-records/${id}`).set(auth(admin.token)).send({ ...base, timeFrom: '22:00', timeTo: '06:00' });
    expect(res.status).toBe(200);
    expect(res.body.data.minutes).toBe(480);
  });

  it('الوقت بصيغة غلط يترفض', async () => {
    const res = await request(app).post('/api/equipment-records').set(auth(admin.token)).send({ ...base, timeTo: '25:00' });
    expect(res.status).toBe(400);
  });

  it('بعد تفعيل الوحدة للمهندس: بيشوف سجلاته هو بس (عزل الملكية)', async () => {
    const en = await request(app).put(`/api/admin/users/${eng.id}/settings`).set(auth(admin.token))
      .send({ enabledModules: ['records', 'submissions', 'equipment'] });
    expect(en.status).toBe(200);
    const mine = await request(app).get('/api/equipment-records').set(auth(eng.token));
    expect(mine.status).toBe(200);
    expect(mine.body.data).toHaveLength(0);
    const other = await request(app).get(`/api/equipment-records/${id}`).set(auth(eng.token));
    expect(other.status).toBe(404);
  });

  it('الحذف مقيّد بالملكية', async () => {
    const no = await request(app).delete(`/api/equipment-records/${id}`).set(auth(eng.token));
    expect(no.status).toBe(404);
    const ok = await request(app).delete(`/api/equipment-records/${id}`).set(auth(admin.token));
    expect(ok.status).toBe(200);
  });
});
