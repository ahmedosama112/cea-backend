import { describe, test, expect } from 'e2e';
import { api, createEngineer, download, loginAdmin, upload, XLSX_BYTES } from './helpers';

const fields = {
  contractorName: 'علاء أحمد محمود',
  placeName: 'عمارة 27',
  weekStart: '2026-08-12',
  weekEnd: '2026-08-18',
  total: '920',
  recordsCount: '2',
  engineerNote: 'كشف الأسبوع',
};
const file = { name: 'سركي.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: XLSX_BYTES };

// إرسال كشف ← ظهوره للمهندس والأدمن ← تنزيل الملف ← مراجعة الأدمن ← الحذف
describe('تسليمات الكشوف', { serial: true }, () => {
  let admin: string;
  let eng: { token: string; id: string };
  let subId: string;

  test('المهندس يبعت كشف (ملف + بيانات) → حالة مُرسَل', async () => {
    admin = (await loginAdmin()).token;
    eng = await createEngineer(admin, 'sub-eng');
    const res = await upload('POST', '/api/submissions', { token: eng.token, fields, file });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('SUBMITTED');
    expect(res.body.data.weekStart).toBe('2026-08-12');
    expect(Number(res.body.data.total)).toBe(920);
    subId = String(res.body.data.id);
  });

  test('من غير ملف = 400', async () => {
    const res = await upload('POST', '/api/submissions', { token: eng.token, fields });
    expect(res.status).toBe(400);
  });

  test('المهندس يشوف تسليماته بس، والقايمة الكاملة للأدمن فقط', async () => {
    const mine = await api('GET', '/api/submissions/mine', { token: eng.token });
    expect(mine.body.data.map((s: { id: unknown }) => String(s.id))).toEqual([subId]);
    const all = await api('GET', `/api/submissions?userId=${eng.id}`, { token: admin });
    expect(all.status).toBe(200);
    expect(all.body.data.map((s: { id: unknown }) => String(s.id))).toContain(subId);
    const engAll = await api('GET', '/api/submissions', { token: eng.token });
    expect(engAll.status).toBe(403);
  });

  test('تنزيل الملف: صاحبه والأدمن بس — غيرهم 404', async () => {
    const own = await download(`/api/submissions/${subId}/file`, eng.token);
    expect(own.status).toBe(200);
    expect(new Uint8Array(await own.arrayBuffer())).toEqual(XLSX_BYTES);
    const adm = await download(`/api/submissions/${subId}/file`, admin);
    expect(adm.status).toBe(200);
    const stranger = await createEngineer(admin, 'sub-stranger');
    const other = await download(`/api/submissions/${subId}/file`, stranger.token);
    expect(other.status).toBe(404);
  });

  test('الأدمن يرفض بملاحظة والمهندس يشوفها؛ المهندس ما يراجعش', async () => {
    const rej = await api('PATCH', `/api/submissions/${subId}/review`, { token: admin, body: { status: 'REJECTED', reviewNote: 'الإجمالي غلط' } });
    expect(rej.status).toBe(200);
    expect(rej.body.data.status).toBe('REJECTED');
    const mine = await api('GET', '/api/submissions/mine', { token: eng.token });
    expect(mine.body.data[0].reviewNote).toBe('الإجمالي غلط');
    const engTry = await api('PATCH', `/api/submissions/${subId}/review`, { token: eng.token, body: { status: 'APPROVED' } });
    expect(engTry.status).toBe(403);
  });

  test('الحذف للأدمن بس', async () => {
    const engDel = await api('DELETE', `/api/submissions/${subId}`, { token: eng.token });
    expect(engDel.status).toBe(403);
    const del = await api('DELETE', `/api/submissions/${subId}`, { token: admin });
    expect(del.status).toBe(200);
    const mine = await api('GET', '/api/submissions/mine', { token: eng.token });
    expect(mine.body.data).toEqual([]);
  });
});
