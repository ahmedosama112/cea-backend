import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';
import { collectSignatures } from '../src/services/approvalChain';
import ExcelJS from 'exceljs';
import { applyRowRejections, dataRowsOf } from '../src/services/rowReject';

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
// كشف عمالة حقيقي بتخطيط الواجهة: 7 صفوف أيام (8..14) بتاريخ في العمود 13، واتنين منهم فيهم إجمالي في العمود 8، وإجمالي الورقة صف 15
async function realLaborXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('مقاول');
  for (let i = 0; i < 7; i++) { const r = 8 + i; ws.getCell(r, 13).value = '2026-08-' + (12 + i); ws.getCell(r, 12).value = 'يوم'; }
  ws.getCell(8, 8).value = 300; ws.getCell(8, 3).value = 'أعمال أ';
  ws.getCell(10, 8).value = 200; ws.getCell(10, 3).value = 'أعمال ب';
  ws.getCell(15, 8).value = 500;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function submitReal(token: string) {
  return request(app).post('/api/submissions').set(auth(token))
    .field('contractorName', 'مقاول').field('placeName', 'موقع').field('weekStart', '2026-08-12')
    .field('weekEnd', '2026-08-18').field('total', '500').field('recordsCount', '2')
    .attach('file', await realLaborXlsx(), 'real.xlsx');
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

  it('مدير فريق تاني بيشوف الكشف في الطابور (الرؤية للجميع) لكن مش دوره (canAct=false) ولا يقدر يعتمده', async () => {
    const sub = (await request(app).get('/api/approvals/queue').set(auth(tl.token))).body.data[0];
    expect(sub.canAct).toBe(true);
    // أسماء المعتمدين المسندين لكل مستوى في سلسلة الكشف (مدير المشروع الوحيد بيتحدد تلقائيًا)
    expect(sub.approverNames['team leader']).toBe('tl');
    expect(sub.approverNames['project manager']).toBe('pm');
    const q2 = await request(app).get('/api/approvals/queue').set(auth(tl2.token));
    const seen = q2.body.data.find((s: { id: string }) => s.id === sub.id);
    expect(seen).toBeDefined();
    expect(seen.canAct).toBe(false);
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
    // (7 سبتمبر — قرار صاحب المشروع) أي معتمد عنده الوحدة يفتح أي كشف (الرؤية للجميع)، والاعتماد هو المحصور
    const otherApprover = await request(app).get(`/api/approvals/${id}/file`).set(auth(tl2.token));
    expect(otherApprover.status).toBe(200);
    const adm = await request(app).get(`/api/approvals/${id}/file`).set(auth(admin.token));
    expect(adm.status).toBe(200);
  });

  it('شطب سطر: بيتلوّن ويتصفّر إجماليه ويتعاد حساب إجمالي الورقة، ويظهر للمعتمد التالي وللمهندس؛ غير المسند ممنوع؛ شطب الكل = رفض كامل', async () => {
    const res = await submitReal(eng.token);
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    // وحدة الخدمة نفسها: صفوف البيانات = 8 و10
    const raw = await realLaborXlsx();
    const wb0 = new ExcelJS.Workbook(); await wb0.xlsx.load(raw as unknown as ArrayBuffer);
    expect(dataRowsOf(wb0.worksheets[0], 'labor')).toEqual([8, 10]);
    const struckBuf = await applyRowRejections(raw, [{ sheetIndex: 0, row: 8, level: 'team leader', note: 'مش شغال اليوم ده' }], 'labor');
    const wb1 = new ExcelJS.Workbook(); await wb1.xlsx.load(struckBuf as unknown as ArrayBuffer);
    const ws1 = wb1.worksheets[0];
    expect(ws1.getCell(8, 13).font?.strike).toBe(true);
    expect(Number(ws1.getCell(8, 8).value)).toBe(0);
    expect(Number(ws1.getCell(15, 8).value)).toBe(200);
    // السطور التانية ما تتأثرش (ExcelJS بيشارك الـ style بين الخلايا — كان الشيت كله بيبقى أحمر)
    expect(ws1.getCell(10, 13).font?.strike).toBeFalsy();
    expect((ws1.getCell(10, 13).fill as { fgColor?: { argb?: string } } | undefined)?.fgColor?.argb).not.toBe('FFFDE8E8');
    expect(ws1.getCell(15, 8).font?.strike).toBeFalsy();
    // نمط 'clear' (نسخة الـ DC): السطر يبقى يوم فاضي — التاريخ واليوم بس، بلا أحمر، والإجمالي متحسب من غيره
    const cleanBuf = await applyRowRejections(raw, [{ sheetIndex: 0, row: 8, level: 'team leader', note: 'x' }], 'labor', 'clear');
    const wbc = new ExcelJS.Workbook(); await wbc.xlsx.load(cleanBuf as unknown as ArrayBuffer);
    const wsc = wbc.worksheets[0];
    expect(String(wsc.getCell(8, 13).value)).toBe('2026-08-12');
    expect(String(wsc.getCell(8, 12).value)).toBe('يوم');
    expect(wsc.getCell(8, 8).value).toBeNull();
    expect(wsc.getCell(8, 3).value).toBeNull();
    expect(wsc.getCell(8, 13).font?.strike).toBeFalsy();
    expect(Number(wsc.getCell(15, 8).value)).toBe(200);
    expect(String(ws1.getCell(8, 3).value)).toContain('❌ مرفوض (team leader): مش شغال اليوم ده');

    // غير المسند (tl2) ممنوع، والسبب إلزامي
    const denied = await request(app).post(`/api/approvals/${id}/rows/reject`).set(auth(tl2.token)).send({ sheetIndex: 0, row: 8, label: 'الأربعاء 2026-08-12', note: 'x' });
    expect(denied.status).toBe(403);
    const noNote = await request(app).post(`/api/approvals/${id}/rows/reject`).set(auth(tl.token)).send({ sheetIndex: 0, row: 8, label: 'الأربعاء 2026-08-12', note: '' });
    expect(noNote.status).toBe(400);
    // المسند (tl) يشطب سطر → الكشف لسه IN_REVIEW، والملف من مسار الاعتمادات فيه الشطب
    const ok = await request(app).post(`/api/approvals/${id}/rows/reject`).set(auth(tl.token)).send({ sheetIndex: 0, row: 8, label: 'الأربعاء 2026-08-12 — 300 ج.م', note: 'مش شغال اليوم ده' });
    expect(ok.status).toBe(201);
    expect(ok.body.fullyRejected).toBe(false);
    const again = await request(app).post(`/api/approvals/${id}/rows/reject`).set(auth(tl.token)).send({ sheetIndex: 0, row: 8, label: 'x', note: 'y' });
    expect(again.status).toBe(400); // مشطوب بالفعل — مفيش إلغاء ولا تكرار
    const q = await request(app).get('/api/approvals/queue').set(auth(tl.token));
    const row = q.body.data.find((s: { id: string }) => s.id === id);
    expect(row.reviewState).toBe('IN_REVIEW');
    expect(row.rowRejections).toHaveLength(1);
    const file = await request(app).get(`/api/approvals/${id}/file`).set(auth(pm.token)).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(file.body as unknown as ArrayBuffer);
    expect(wb2.worksheets[0].getCell(8, 13).font?.strike).toBe(true);
    expect(Number(wb2.worksheets[0].getCell(15, 8).value)).toBe(200);
    // المهندس يشوف السطر المشطوب وسببه في تسليماته
    const mine = await request(app).get('/api/submissions/mine').set(auth(eng.token));
    const m = mine.body.data.find((s: { id: string }) => s.id === id);
    expect(m.rowRejections[0].note).toBe('مش شغال اليوم ده');
    // شطب السطر الأخير → رفض كامل تلقائي
    const last = await request(app).post(`/api/approvals/${id}/rows/reject`).set(auth(tl.token)).send({ sheetIndex: 0, row: 10, label: 'الجمعة 2026-08-14 — 200 ج.م', note: 'كمان' });
    expect(last.status).toBe(201);
    expect(last.body.fullyRejected).toBe(true);
    const after = await prisma.submission.findUnique({ where: { id: BigInt(id) }, include: { reviews: true } });
    expect(after!.reviewState).toBe('RETURNED');
    expect(after!.reviews.some((r) => r.decision === 'REJECTED' && r.note?.includes('كل سطور الكشف اتشطبت'))).toBe(true);
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

  it('ختم التوقيعات: كل مستوى بياخد توقيع الشخص اللي اعتمد فعلًا (من حسابه)', async () => {
    // PNG صالح (1x1) — بيترفع كتوقيع للحسابين زي ما بيحصل من شاشة "توقيع المهندس"
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const upload = async (u: TestUser) => {
      const f = await request(app).post('/api/files').set(auth(u.token)).attach('file', png, 'sig.png');
      expect(f.status).toBe(201);
      // التوقيع بيتربط بالحساب من لوحة الإدارة (نفس شاشة "توقيع المهندس")
      const st = await request(app).put(`/api/admin/users/${u.id}/settings`).set(auth(admin.token)).send({ signatureFileId: f.body.data.id });
      expect(st.status).toBe(200);
    };
    await upload(tl); // مدير الفريق رفع توقيعه
    await upload(pm); // مدير المشروع رفع توقيعه — ومدير التنفيذ لأ (بلوكه هيفضل فاضي)

    await patchUser(admin.token, eng.id, { approverCmId: cm.id });
    const res = await submit(eng.token);
    const id = res.body.data.id;
    await request(app).post(`/api/approvals/${id}/decide`).set(auth(tl.token)).send({ decision: 'APPROVED' });
    await request(app).post(`/api/approvals/${id}/decide`).set(auth(cm.token)).send({ decision: 'APPROVED' });
    await request(app).post(`/api/approvals/${id}/decide`).set(auth(pm.token)).send({ decision: 'APPROVED_NOTES', note: 'تمام' });

    const sub = await prisma.submission.findUnique({
      where: { id: BigInt(id) },
      include: { reviews: { include: { byUser: { select: { email: true, title: true, accountSettings: { select: { signatureFile: true } } } } } } },
    });
    const sigs = await collectSignatures(sub!.reviews as never, sub!.revision);
    const withImage = sigs.filter((x) => x.image).map((x) => x.level).sort();
    expect(withImage).toEqual(['project manager', 'team leader']); // مدير التنفيذ مرفعش توقيع → بلوكه بلا صورة
    expect(sigs.filter((x) => x.image).every((x) => (x.image as Buffer).length > 0 && x.ext === 'png')).toBe(true);
    // كل مستوى بيحمل اسم اللي اعتمده وتاريخه ("معتمد بواسطة") حتى بلا توقيع
    expect(sigs.find((x) => x.level === 'construction manager')?.by).toBe('cm');
    expect(sigs.every((x) => x.by && x.at)).toBe(true);

    await patchUser(admin.token, eng.id, { approverCmId: null });
  });

  it('المصفوفة قابلة للتعديل: الترتيب بيتفرض بترتيب السلم، والسلسلة الجديدة بتتطبق على الكشوف الجاية', async () => {
    // junior: نشيل مدير التنفيذ ونسيب مدير الفريق + مدير المشروع (بترتيب مقلوب عمدًا)
    const put = await request(app).put('/api/admin/approval-matrix').set(auth(admin.token))
      .send({ matrix: { junior: ['project manager', 'team leader'], senior: ['team leader'], 'team leader': [], 'construction manager': [], 'project manager': [] } });
    expect(put.status).toBe(200);
    expect(put.body.data.junior).toEqual(['team leader', 'project manager']); // اترتبت بترتيب السلم
    expect(put.body.data.senior).toEqual(['team leader']);

    // كشف junior جديد: مدير الفريق ← مدير المشروع (مدير التنفيذ اتشال من السلسلة)
    await patchUser(admin.token, eng.id, { approverCmId: cm.id });
    const res = await submit(eng.token);
    expect(res.body.data.currentLevel).toBe('team leader');
    const a = await request(app).post(`/api/approvals/${res.body.data.id}/decide`).set(auth(tl.token)).send({ decision: 'APPROVED' });
    expect(a.body.data.currentLevel).toBe('project manager'); // عدّى مدير التنفيذ رغم إنه مسند
    const b = await request(app).post(`/api/approvals/${res.body.data.id}/decide`).set(auth(pm.token)).send({ decision: 'APPROVED' });
    expect(b.body.data.reviewState).toBe('SENT');

    const info = await request(app).get('/api/admin/approval-matrix').set(auth(admin.token));
    expect(info.body.data.matrix.junior).toEqual(['team leader', 'project manager']);
    expect(typeof info.body.data.inReview).toBe('number');

    // نرجّع الافتراضي لباقي الاختبارات
    const restore = await request(app).put('/api/admin/approval-matrix').set(auth(admin.token))
      .send({ matrix: { junior: ['team leader', 'construction manager', 'project manager'], senior: ['team leader', 'construction manager', 'project manager'], 'team leader': ['construction manager', 'project manager'], 'construction manager': [], 'project manager': [] } });
    expect(restore.status).toBe(200);
    expect(restore.body.data['team leader']).toEqual(['construction manager', 'project manager']);
    await patchUser(admin.token, eng.id, { approverCmId: null });
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
