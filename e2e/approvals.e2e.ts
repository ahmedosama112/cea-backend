import { describe, test, expect } from 'e2e';
import { api, createEngineer, loginAdmin, patchUser, setModules, upload, XLSX_BYTES, type Session } from './helpers';

// سلسلة اعتماد المديرين: مهندس (junior) ← مدير الفريق المسند له ← مدير المشروع ← SENT
// ⚠ ده الملف الوحيد اللي بيعمل "project manager": مدير المشروع بيتحدد تلقائيًا لما يبقى واحد بس في النظام

const fields = {
  contractorName: 'مقاول',
  placeName: 'موقع',
  weekStart: '2026-08-12',
  weekEnd: '2026-08-18',
  total: '500',
  recordsCount: '2',
};
const xlsx = (name: string) => ({ name, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: XLSX_BYTES });

describe('اعتمادات المديرين', { serial: true }, () => {
  let eng: Session, tl: Session, tl2: Session, pm: Session;
  let subId: string;

  test('المهندس يبعت كشف → يدخل السلسلة عند مدير فريقه المسند', async () => {
    const admin = (await loginAdmin()).token;
    eng = await createEngineer(admin, 'apr-eng');
    tl = await createEngineer(admin, 'apr-tl', ['records', 'submissions', 'approvals']);
    tl2 = await createEngineer(admin, 'apr-tl2', ['records', 'submissions', 'approvals']);
    pm = await createEngineer(admin, 'apr-pm', ['records', 'submissions', 'approvals']);
    await patchUser(admin, tl.id, { grade: 'team leader' });
    await patchUser(admin, tl2.id, { grade: 'team leader' });
    await patchUser(admin, pm.id, { grade: 'project manager' });
    await patchUser(admin, eng.id, { approverTlId: tl.id });
    await setModules(admin, eng.id, ['records', 'submissions']);

    const res = await upload('POST', '/api/submissions', { token: eng.token, fields, file: xlsx('k.xlsx') });
    expect(res.status).toBe(201);
    expect(res.body.data.reviewState).toBe('IN_REVIEW');
    expect(res.body.data.currentLevel).toBe('team leader');
    expect(String(res.body.data.currentApproverId)).toBe(tl.id);
    expect(res.body.data.revision).toBe(0);
    subId = String(res.body.data.id);
  });

  test('مدير فريق تاني يشوف الكشف بس مش دوره ولا يقدر يعتمده', async () => {
    const q = await api('GET', '/api/approvals/queue', { token: tl2.token });
    const row = q.body.data.find((s: { id: unknown }) => String(s.id) === subId);
    expect(row).toBeDefined();
    expect(row.canAct).toBe(false);
    const tryIt = await api('POST', `/api/approvals/${subId}/decide`, { token: tl2.token, body: { decision: 'APPROVED' } });
    expect(tryIt.status).toBe(403);
  });

  test('مدير المشروع ما يعتمدش قبل دوره؛ مدير الفريق يعتمد فينتقل لمدير المشروع', async () => {
    const early = await api('POST', `/api/approvals/${subId}/decide`, { token: pm.token, body: { decision: 'APPROVED' } });
    expect(early.status).toBe(403);
    const q = await api('GET', '/api/approvals/queue', { token: tl.token });
    expect(q.body.data.find((s: { id: unknown }) => String(s.id) === subId).canAct).toBe(true);
    const t = await api('POST', `/api/approvals/${subId}/decide`, { token: tl.token, body: { decision: 'APPROVED' } });
    expect(t.status).toBe(200);
    expect(t.body.data.currentLevel).toBe('project manager');
    expect(String(t.body.data.currentApproverId)).toBe(pm.id);
  });

  test('آخر معتمد يعتمد بملاحظة → السلسلة تخلص (SENT)', async () => {
    const p = await api('POST', `/api/approvals/${subId}/decide`, {
      token: pm.token,
      body: { decision: 'APPROVED_NOTES', note: 'تمام مع ملاحظة بسيطة' },
    });
    expect(p.status).toBe(200);
    expect(p.body.data.reviewState).toBe('SENT');
    expect(p.body.data.currentLevel).toBeNull();
    expect(p.body.data.reviews).toHaveLength(2);
  });

  test('الرفض لازم ملاحظة، والكشف المرفوض يرجع للمهندس (RETURNED)', async () => {
    const res = await upload('POST', '/api/submissions', { token: eng.token, fields, file: xlsx('k.xlsx') });
    subId = String(res.body.data.id);
    const noNote = await api('POST', `/api/approvals/${subId}/decide`, { token: tl.token, body: { decision: 'REJECTED' } });
    expect(noNote.status).toBe(400);
    const rej = await api('POST', `/api/approvals/${subId}/decide`, { token: tl.token, body: { decision: 'REJECTED', note: 'الإجمالي غلط' } });
    expect(rej.status).toBe(200);
    expect(rej.body.data.reviewState).toBe('RETURNED');
    const mine = await api('GET', '/api/submissions/mine', { token: eng.token });
    expect(mine.body.data.find((s: { id: unknown }) => String(s.id) === subId).reviewState).toBe('RETURNED');
  });

  test('إعادة الإرسال تزوّد رقم النسخة وتبدأ السلسلة من أولها، والنسخة القديمة محفوظة', async () => {
    const resend = await upload('POST', `/api/submissions/${subId}/resend`, { token: eng.token, file: xlsx('k2.xlsx') });
    expect(resend.status).toBe(200);
    expect(resend.body.data.revision).toBe(1);
    expect(resend.body.data.reviewState).toBe('IN_REVIEW');
    expect(resend.body.data.currentLevel).toBe('team leader');

    const q = await api('GET', '/api/approvals/queue', { token: tl.token });
    const row = q.body.data.find((s: { id: unknown }) => String(s.id) === subId);
    expect(row.revisions).toHaveLength(1);
    expect(row.revisions[0].file.fileName).toBe('k.xlsx');
    expect(row.file.fileName).toBe('k2.xlsx');
  });
});
