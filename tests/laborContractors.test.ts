import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';
import { applyRowRejections, workbookLaborDaysByContractor } from '../src/services/rowReject';
import { saveLaborDays } from '../src/services/laborContractors';

// مقاولين العمالة (2026-09-19): كشفهم لوحده + مكان إلزامي + يوميات قبل/بعد الاعتماد لكل مهندس

const RLM = '‏';
const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x74, 0x65, 0x73, 0x74]);

// ورقة بتخطيط الواجهة: J3 اسم المقاول، صفوف الأيام 8..14 (تاريخ عمود 13، قيمة عمود 8، الكمية عمود 11)
function laborSheet(wb: ExcelJS.Workbook, sheetName: string, contractor: string, rows: Array<{ r: number; qty: string; value: number }>) {
  const ws = wb.addWorksheet(sheetName);
  ws.getCell(3, 10).value = contractor;
  for (let i = 0; i < 7; i++) { ws.getCell(8 + i, 13).value = '2026-09-' + (12 + i); ws.getCell(8 + i, 12).value = 'يوم'; }
  for (const x of rows) { ws.getCell(x.r, 11).value = x.qty; ws.getCell(x.r, 8).value = x.value; }
  ws.getCell(15, 8).value = rows.reduce((a, x) => a + x.value, 0);
}

describe('يوميات العمالة من ملف الكشف', () => {
  async function book(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    // يوم فيه سجلين (سطرين في نفس الخانة) + يوم بالساعة (مايتحسبش)
    laborSheet(wb, 'أحمد عيد - برج 1', 'أحمد عيد', [
      { r: 8, qty: `${RLM}5 يومية\n${RLM}2 يومية`, value: 700 },
      { r: 10, qty: `${RLM}8 ساعة`, value: 400 },
    ]);
    // نفس المقاول في مكان تاني = ورقة تانية بتتجمع معاه
    laborSheet(wb, 'أحمد عيد - برج 2', 'أحمد عيد', [{ r: 9, qty: `${RLM}1.5 يومية`, value: 150 }]);
    laborSheet(wb, 'الليثي', 'محمد أحمد الليثي', [{ r: 11, qty: `${RLM}4 يومية`, value: 400 }]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('بيجمع كل سطور اليوم وكل ورقات المقاول، والساعة برّه', async () => {
    const m = await workbookLaborDaysByContractor(await book());
    expect(m!.get('أحمد عيد')).toBe(8.5);
    expect(m!.get('محمد أحمد الليثي')).toBe(4);
  });

  it('السطر المشطوب مايتحسبش في بعد الاعتماد', async () => {
    const cleared = await applyRowRejections(await book(), [{ sheetIndex: 0, row: 8 } as never], 'labor', 'clear');
    const m = await workbookLaborDaysByContractor(cleared);
    expect(m!.get('أحمد عيد')).toBe(1.5);
  });
});

describe('قواعد إرسال كشف العمالة + تقرير العمالة', () => {
  let admin: TestUser, eng: TestUser;

  function submit(token: string, contractorName: string, placeName: string) {
    return request(app).post('/api/submissions').set(auth(token))
      .field('contractorName', contractorName).field('placeName', placeName).field('weekStart', '2026-09-12')
      .field('weekEnd', '2026-09-18').field('total', '500').field('recordsCount', '2')
      .attach('file', xlsx, 'k.xlsx');
  }

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    eng = await createEngineer(admin.token, 'eng@test.com');
    await request(app).put(`/api/admin/users/${eng.id}/settings`).set(auth(admin.token)).send({ enabledModules: ['records', 'submissions', 'analytics'] });
    await request(app).post('/api/contractors').set(auth(admin.token)).send({ name: 'أحمد عيد', isLabor: true });
    await request(app).post('/api/contractors').set(auth(admin.token)).send({ name: 'مقاول نجارة' });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('العلامة isLabor بتترجع في قايمة المقاولين', async () => {
    const res = await request(app).get('/api/contractors').set(auth(admin.token));
    const c = res.body.data.find((x: { name: string }) => x.name === 'أحمد عيد');
    expect(c.isLabor).toBe(true);
  });

  it('كشف من غير مكان مرفوض', async () => {
    const res = await submit(eng.token, 'مقاول نجارة', '');
    expect(res.status).toBe(400);
  });

  it('مقاول عمالة مع مقاول تاني في نفس الكشف مرفوض', async () => {
    const res = await submit(eng.token, 'احمد عيد، مقاول نجارة', 'برج 1'); // كتابة مختلفة للهمزة لسه بتتعرف
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('لوحدهم');
  });

  it('مقاول عمالة لوحده + مكان مقبول، ومقاول عادي + مكان مقبول', async () => {
    expect((await submit(eng.token, 'أحمد عيد', 'برج 1')).status).toBe(201);
    expect((await submit(eng.token, 'مقاول نجارة', 'برج 1')).status).toBe(201);
  });

  it('التقرير: قبل الاعتماد من السجلات، وبعده من الكشوف المعتمدة — لكل مهندس', async () => {
    for (const [date, qty] of [['2026-09-13', 5], ['2026-09-14', 3]] as const) {
      await request(app).post('/api/records').set(auth(eng.token)).send({
        day: 'الاثنين', date, contractor: 'أحمد عيد', place: 'برج 1', qty, qtyType: 'يومية', price: 100, discount: 0,
      });
    }
    const file = await prisma.file.create({
      data: { userId: BigInt(eng.id), fileName: 'k.xlsx', filePath: 'x/k.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileSize: 10 },
    });
    const sub = await prisma.submission.create({
      data: {
        userId: BigInt(eng.id), fileId: file.id, contractorName: 'أحمد عيد', placeName: 'برج 1', total: 800,
        weekStart: new Date('2026-09-12'), weekEnd: new Date('2026-09-18'), recordsCount: 2, kind: 'labor', reviewState: 'SENT',
      },
    });
    await prisma.submissionReview.create({ data: { submissionId: sub.id, level: 'project manager', decision: 'APPROVED', revision: 0 } });
    await saveLaborDays(sub.id, new Map([['أحمد عيد', 6], ['مقاول نجارة', 9]])); // النجارة مش عمالة → مايتخزنش

    const res = await request(app).get('/api/analytics/labor?from=2026-09-01&to=2026-09-30&fresh=1').set(auth(admin.token));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.contractors).toHaveLength(1);
    expect(d.contractors[0].name).toBe('أحمد عيد');
    expect(d.contractors[0].before).toBe(8);
    expect(d.contractors[0].after).toBe(6);
    expect(d.contractors[0].engineers[0].diff).toBe(2);
    expect(d.totals.after).toBe(6);
  });
});

describe('تحليل العمالة (labor_analytics) — وحدة مستقلة، كل المهندسين', () => {
  let admin: TestUser, engA: TestUser, engB: TestUser;

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
    engA = await createEngineer(admin.token, 'labor-a@test.com');
    // engB حساب مهندس عادي، درجة افتراضية، مش معتمد لحد — بس هيدّيله الأدمن وحدة labor_analytics بس
    engB = await createEngineer(admin.token, 'labor-b@test.com');
    await request(app).put(`/api/admin/users/${engA.id}/settings`).set(auth(admin.token)).send({ enabledModules: ['records', 'submissions', 'analytics'] });
    await request(app).put(`/api/admin/users/${engB.id}/settings`).set(auth(admin.token)).send({ enabledModules: ['labor_analytics'] });
    await request(app).post('/api/contractors').set(auth(admin.token)).send({ name: 'صبحي للعمالة', isLabor: true });

    // engA بيسجّل سركي عمالة لسه معلّق (قبل الاعتماد) — ده اللي المفروض engB يشوفه رغم إنه مش مسند له
    await request(app).post('/api/records').set(auth(engA.token)).send({
      day: 'الاثنين', date: '2026-09-13', contractor: 'صبحي للعمالة', place: 'برج 1', qty: 4, qtyType: 'يومية', price: 100, discount: 0,
    });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('engB (مالوش وحدة analytics ولا إسناد) بيشوف يوميات engA في /api/labor-analytics', async () => {
    const res = await request(app).get('/api/labor-analytics?fresh=1').set(auth(engB.token));
    expect(res.status).toBe(200);
    const c = res.body.data.contractors.find((x: { name: string }) => x.name === 'صبحي للعمالة');
    expect(c).toBeTruthy();
    expect(c.before).toBe(4);
  });

  it('engB مرفوض على /api/analytics/labor (الوحدة دي مش عنده)', async () => {
    const res = await request(app).get('/api/analytics/labor').set(auth(engB.token));
    expect(res.status).toBe(403);
  });

  it('engB بيشوف engA في /api/labor-analytics/scope', async () => {
    const res = await request(app).get('/api/labor-analytics/scope').set(auth(engB.token));
    expect(res.status).toBe(200);
    expect(res.body.data.level).toBe('all');
    expect(res.body.data.engineers.some((u: { email: string }) => u.email === 'labor-a@test.com')).toBe(true);
  });

  it('حساب من غير وحدة labor_analytics مرفوض 403', async () => {
    const res = await request(app).get('/api/labor-analytics').set(auth(engA.token)); // engA معاه analytics بس مش labor_analytics
    expect(res.status).toBe(403);
  });
});
