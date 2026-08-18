import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';

describe('Entities + admin-managed data', () => {
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

  describe('المقاولون', () => {
    it('CRUD كامل + rateType بالنص العربي في الاتجاهين', async () => {
      const created = await request(app).post('/api/contractors').set(auth(admin.token))
        .send({ name: 'مقاول جديد', spec: 'نقاش', rate: 350, rateType: 'ساعة' });
      expect(created.status).toBe(201);
      expect(created.body.data.rateType).toBe('ساعة');

      const list = await request(app).get('/api/contractors').set(auth(admin.token));
      expect(list.body.data[0].rateType).toBe('ساعة');

      const updated = await request(app).put(`/api/contractors/${created.body.data.id}`).set(auth(admin.token))
        .send({ rateType: 'مقطوعية' });
      expect(updated.body.data.rateType).toBe('مقطوعية');
    });

    it('اسم مكرر لنفس المستخدم = 409، ومسموح لمستخدم مختلف', async () => {
      const dup = await request(app).post('/api/contractors').set(auth(admin.token))
        .send({ name: 'مقاول جديد' });
      expect(dup.status).toBe(409);

      const other = await request(app).post('/api/contractors').set(auth(eng.token))
        .send({ name: 'مقاول جديد' });
      expect(other.status).toBe(201);
    });
  });

  describe('الأماكن (بيانات مُدارة من الأدمن)', () => {
    it('المهندس يقرأ فقط — الكتابة كلها 403', async () => {
      const add = await request(app).post('/api/places').set(auth(eng.token)).send({ name: 'مرفوض' });
      expect(add.status).toBe(403);
    });

    it('الأدمن يزرع مكانًا في حساب المهندس والمهندس يشوفه', async () => {
      const seed = await request(app).post(`/api/admin/users/${eng.id}/places`).set(auth(admin.token))
        .send({ name: 'عمارة 30' });
      expect(seed.status).toBe(201);

      const engView = await request(app).get('/api/places').set(auth(eng.token));
      expect(engView.body.data.map((p: { name: string }) => p.name)).toContain('عمارة 30');

      const engDelete = await request(app).delete(`/api/places/${seed.body.data.id}`).set(auth(eng.token));
      expect(engDelete.status).toBe(403);
    });

    it('مسارات /api/admin كلها ممنوعة على المهندس', async () => {
      const list = await request(app).get('/api/admin/users').set(auth(eng.token));
      expect(list.status).toBe(403);
      const seed = await request(app).post(`/api/admin/users/${admin.id}/places`).set(auth(eng.token))
        .send({ name: 'اختراق' });
      expect(seed.status).toBe(403);
    });
  });

  describe('إعدادات الحساب (PIN/التوقيع)', () => {
    it('الأدمن يحط PIN للمهندس — والمهندس يقرأه ولا يعدله', async () => {
      const pin = 'f'.repeat(64);
      const set = await request(app).put(`/api/admin/users/${eng.id}/settings`).set(auth(admin.token))
        .send({ pinHash: pin });
      expect(set.status).toBe(200);

      const read = await request(app).get('/api/account/settings').set(auth(eng.token));
      expect(read.body.data.pinHash).toBe(pin);

      const overwrite = await request(app).put('/api/account/settings').set(auth(eng.token))
        .send({ pinHash: 'e'.repeat(64) });
      expect(overwrite.status).toBe(403);
    });
  });

  describe('البنود والمراحل', () => {
    let itemId: string;

    it('إنشاء بند بمراحل متداخلة', async () => {
      const res = await request(app).post('/api/items').set(auth(admin.token))
        .send({ cat: 'بياض', name: 'بياض اختبار', stages: [{ name: 'تجهيز', pct: 30 }, { name: 'تنفيذ', pct: 70 }] });
      expect(res.status).toBe(201);
      expect(res.body.data.stages).toEqual([{ name: 'تجهيز', pct: 30 }, { name: 'تنفيذ', pct: 70 }]);
      itemId = res.body.data.id;
    });

    it('تعديل البند يستبدل المراحل بالكامل (نفس سلوك الواجهة)', async () => {
      const res = await request(app).put(`/api/items/${itemId}`).set(auth(admin.token))
        .send({ cat: 'بياض', name: 'بياض اختبار', stages: [{ name: 'مرحلة واحدة', pct: 100 }] });
      expect(res.body.data.stages).toEqual([{ name: 'مرحلة واحدة', pct: 100 }]);
      const stagesInDb = await prisma.itemStage.count({ where: { itemId: BigInt(itemId) } });
      expect(stagesInDb).toBe(1);
    });
  });

  describe('الموقف التنفيذي', () => {
    it('stages + stageDone بنفس شكل الواجهة بالظبط', async () => {
      const res = await request(app).post('/api/exec-records').set(auth(admin.token))
        .send({
          item: 'بياض داخلي', place: 'عمارة 28', pct: 55, notes: 'جاري',
          stages: [{ name: 'تجهيز', pct: 20, done: true }, { name: 'تنفيذ', pct: 80, done: false }],
        });
      expect(res.status).toBe(201);
      const d = res.body.data;
      expect(d.stages).toEqual([{ name: 'تجهيز', pct: 20 }, { name: 'تنفيذ', pct: 80 }]);
      expect(d.stageDone).toEqual([true, false]);
      expect(d.pct).toBe(55);
      expect(d.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('المهام وطلبات الفحص', () => {
    it('todo دورة كاملة', async () => {
      const created = await request(app).post('/api/todos').set(auth(admin.token))
        .send({ date: '2026-08-20', notes: 'مهمة اختبار', place: 'عمارة 27', priority: 'عاجل' });
      expect(created.status).toBe(201);
      const upd = await request(app).put(`/api/todos/${created.body.data.id}`).set(auth(admin.token))
        .send({ done: true });
      expect(upd.body.data.done).toBe(true);
    });

    it('IR بحالة عربية وحقول كاملة', async () => {
      const res = await request(app).post('/api/ir-records').set(auth(admin.token))
        .send({ date: '2026-08-18', item: 'بلاط موزايكو أسطح', place: 'عمارة 27', inspector: 'م. عمرو زكريا', status: 'B', notes: 'ملاحظات' });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('B');
    });
  });
});
