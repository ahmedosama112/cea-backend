import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth, TestUser } from './helpers';
import { invalidateModulesCache } from '../src/middlewares/moduleGuard';
import { storage } from '../src/services/storage';
import { pushSubmissionToSheet } from '../src/services/approvalChain';
import { approvedTotalsReport, laborReport } from '../src/services/analytics.service';
import { saveLaborDays } from '../src/services/laborContractors';
import { rowDate } from '../src/services/rowReject';
import * as google from '../src/services/googleSheet';

let admin: TestUser, eng: TestUser, pm: TestUser, other: TestUser;
async function file(kind='labor', rows=[8,9,10], move=false, dates?: ExcelJS.CellValue[]): Promise<Buffer> {
  const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('مقاول - مكان');
  ws.getCell(3,10).value='مقاول'; ws.getCell(4,10).value='مكان';
  for (const [i,r] of rows.entries()) {
    const date = dates ? dates[i] : `2026-10-${String(move?i+7:r-1).padStart(2,'0')}`;
    ws.getCell(r,kind==='labor'?12:13).value=date;
    ws.getCell(r,kind==='labor'?13:12).value=typeof date==='string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date+'T00:00:00Z').toLocaleDateString('ar-EG',{weekday:'long',timeZone:'UTC'}) : 'الأربعاء';
    if(kind==='labor') {ws.getCell(r,11).value='1 يومية';ws.getCell(r,9).value=10;ws.getCell(r,8).value=10;ws.getCell(r,3).value='أعمال';}
    else { ws.mergeCells(r,8,r,9);ws.mergeCells(r,10,r,11);ws.getCell(r,8).value='08:00 – 10:00';ws.getCell(r,10).value='مكان';ws.getCell(r,7).value='2:00'; }
  }
  if(kind==='labor')ws.getCell(15,8).value=rows.length*10;
  else {ws.mergeCells(13,8,13,13);ws.getCell(13,7).value=`${rows.length*2}:00`;}
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function submit(kind='labor', rows=[8,9,10], buffer?: Buffer, total?: number) {
  const r=await request(app).post('/api/submissions').set(auth(eng.token))
    .field('contractorName','مقاول').field('placeName','مكان').field('kind',kind).field('projectId','1')
    .field('weekStart','2026-10-01').field('weekEnd','2026-10-31').field('total',String(total ?? (kind==='labor'?rows.length*10:rows.length*2))).field('recordsCount',String(rows.length))
    .attach('file',buffer ?? await file(kind,rows),'source.xlsx');expect(r.status,r.body.message).toBe(201);return r.body.data.id as string;
}
async function strike(id:string,row=8,disposition='CORRECTION') {
  return request(app).post(`/api/approvals/${id}/rows/reject`).set(auth(pm.token)).send({sheetIndex:0,row,label:'يوم',note:'راجع العدد',disposition});
}
async function decide(id:string,decision='APPROVED') {
  return request(app).post(`/api/approvals/${id}/decide`).set(auth(pm.token)).send({decision,note:decision==='REJECTED'?'عدّل الكشف':''});
}
async function tasks(state='OPEN',token=eng.token) {
  return request(app).get('/api/submissions/corrections?state='+state).set(auth(token));
}
async function draft(ids:string[]) {return request(app).post('/api/submissions/corrections/drafts').set(auth(eng.token)).send({taskIds:ids});}
async function ready(kind='labor', count=1, buffer?: Buffer, total?: number) {
  const id=await submit(kind,[8,9,10],buffer,total);
  for(let row=8;row<8+count;row++)expect((await strike(id,row)).status).toBe(201);
  expect((await decide(id)).status).toBe(200);
  const t=(await tasks()).body.data;
  const d=await draft(t.map((x:{id:string})=>x.id));expect(d.status,d.body.message).toBe(201);
  return {id,t,d:d.body.data};
}
async function send(d:{id:string;version:number}) {
  return request(app).post(`/api/submissions/corrections/drafts/${d.id}/submit`).set(auth(eng.token)).send({version:d.version});
}
beforeEach(async()=>{
  await resetDb();
  admin=await createAdmin();pm=await createEngineer(admin.token,'pm@test.com');eng=await createEngineer(admin.token);other=await createEngineer(admin.token,'stranger@test.com');
  await prisma.user.update({where:{id:BigInt(pm.id)},data:{grade:'project manager'}});
  await prisma.user.update({where:{id:BigInt(eng.id)},data:{grade:'junior',approverPmId:BigInt(pm.id)}});
  await prisma.accountSettings.upsert({where:{userId:BigInt(pm.id)},create:{userId:BigInt(pm.id),enabledModules:['approvals','submissions']},update:{enabledModules:['approvals','submissions']}});
  invalidateModulesCache(BigInt(pm.id));
  await prisma.contractor.create({data:{userId:BigInt(admin.id),name:'مقاول',isLabor:true}});
});
afterAll(async()=>{vi.restoreAllMocks();await prisma.$disconnect();});

describe('correction obligations use the existing approval chain',()=>{
  it('requires a disposition, actual data row, reason, and assigned approver',async()=>{
    const id=await submit();
    const url=`/api/approvals/${id}/rows/reject`;
    const base={sheetIndex:0,row:8,label:'يوم',note:'سبب'};
    expect((await request(app).post(url).set(auth(pm.token)).send(base)).status).toBe(400);
    expect((await strike(id,4)).status).toBe(400);
    expect((await request(app).post(url).set(auth(pm.token)).send({...base,disposition:'CORRECTION',note:''})).status).toBe(400);
    expect((await request(app).post(url).set(auth(other.token)).send({...base,disposition:'CORRECTION'})).status).toBe(403);
  });
  it('FINAL creates no correction; legacy rows stay unclassified and list reads never write',async()=>{
    const id=await submit();expect((await strike(id,8,'FINAL')).status).toBe(201);
    await prisma.submissionRowRejection.create({data:{submissionId:BigInt(id),revision:0,sheetIndex:0,row:9,label:'قديم',level:'project manager',note:'قديم',byUserId:BigInt(pm.id)}});
    await prisma.submissionComment.deleteMany({ where: { submissionId: BigInt(id) } });
    const finalAudit=await prisma.submissionRowRejection.findFirstOrThrow({where:{row:8}});expect(finalAudit.classifiedById).toBe(BigInt(pm.id));expect(finalAudit.classificationNote).toBe('راجع العدد');
    expect((await tasks()).body.data).toEqual([]);await tasks();
    expect(await prisma.correctionTask.count()).toBe(0);
    expect((await prisma.submissionRowRejection.findFirst({where:{row:9}}))?.disposition).toBeNull();
  });
  it('a fully FINAL submission has no obligation and cannot be resent with unrelated days',async()=>{
    const id=await submit('labor',[8]);expect((await strike(id,8,'FINAL')).status).toBe(201);
    expect((await tasks()).body.summary).toEqual({submissions:0,days:0});
    const r=await request(app).post(`/api/submissions/${id}/resend`).set(auth(eng.token)).attach('file',await file('labor',[10]),'unrelated.xlsx');expect(r.status).toBe(409);
    expect(await prisma.correctionTask.count()).toBe(0);expect(await prisma.submissionRevision.count()).toBe(0);
  });
  it('explicit legacy classification is audited, cannot reopen FINAL, and preserves money',async()=>{
    const id=await submit();await prisma.submissionRowRejection.create({data:{submissionId:BigInt(id),sheetIndex:0,row:8,label:'قديم',level:'project manager',note:'شطب قديم'}});
    const url=`/api/approvals/${id}/rows/classify`;const body={revision:0,sheetIndex:0,row:8,disposition:'CORRECTION',note:'راجعت الإرسال القديم'};
    const responses=await Promise.all([request(app).post(url).set(auth(pm.token)).send(body),request(app).post(url).set(auth(pm.token)).send(body)]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
    expect(await prisma.correctionTask.count()).toBe(1);expect(await prisma.correctionEvent.count()).toBe(1);
    const classified=await prisma.submissionRowRejection.findFirstOrThrow();expect(classified.classifiedById).toBe(BigInt(pm.id));expect(classified.classifiedAt).not.toBeNull();expect(classified.classificationNote).toBe(body.note);
    expect((await tasks()).body.data[0].legacyReview).toBe(true);
    expect(Number((await prisma.submission.findUnique({where:{id:BigInt(id)}}))!.total)).toBe(30);
    expect((await request(app).post(url).set(auth(pm.token)).send({...body,disposition:'FINAL'})).status).toBe(409);
  });
  it('old and hidden full rejections stay visible; partial tasks are not double counted',async()=>{
    const id=await submit();expect((await strike(id)).status).toBe(201);expect((await decide(id,'REJECTED')).status).toBe(200);
    await prisma.submission.update({where:{id:BigInt(id)},data:{submittedAt:new Date('2020-01-01'),queueHiddenAt:new Date()}});
    const t=(await tasks()).body;expect(t.summary).toEqual({submissions:1,days:0});expect(t.data).toHaveLength(1);expect(t.data[0].row).toBe(0);
    expect((await request(app).get('/api/approvals/queue').set(auth(pm.token))).body.data).toHaveLength(0);
    expect((await request(app).get('/api/approvals/corrections').set(auth(pm.token))).body.data).toHaveLength(1);
    expect((await tasks('OPEN',other.token)).body.data).toHaveLength(0);
  });
  it('rejects drafting until the original review is complete; opening or saving is not resend',async()=>{
    const id=await submit();await strike(id);const ts=(await tasks()).body.data;
    expect((await draft([ts[0].id])).status).toBe(409);
    await decide(id);const d=(await draft([ts[0].id])).body.data;
    expect((await request(app).get(`/api/submissions/corrections/drafts/${d.id}`).set(auth(eng.token))).status).toBe(200);
    const patch=await request(app).patch(`/api/submissions/corrections/drafts/${d.id}`).set(auth(eng.token)).send({version:0,edits:[{taskId:ts[0].id,qty:'2',price:'11',notes:'تعديل'}]});expect(patch.status).toBe(200);
    expect((await tasks()).body.summary.days).toBe(1);expect(await prisma.correctionLink.count()).toBe(0);
    expect((await request(app).delete(`/api/submissions/corrections/drafts/${d.id}`).set(auth(eng.token))).status).toBe(200);expect((await tasks()).body.summary.days).toBe(1);
  });
  it('copies only requested days, recalculates from edits, and preserves source project/site despite account changes',async()=>{
    const {id,t,d}=await ready();
    await prisma.user.update({where:{id:BigInt(eng.id)},data:{site:2}});
    const patch=await request(app).patch(`/api/submissions/corrections/drafts/${d.id}`).set(auth(eng.token)).send({version:0,edits:[{taskId:t[0].id,qty:'2',price:'11',notes:'صحيح'}]});expect(patch.status).toBe(200);
    const r=await send({...d,version:1});expect(r.status,r.body.message).toBe(201);
    const sub=await prisma.submission.findUniqueOrThrow({where:{id:BigInt(r.body.data.id)},include:{file:true}});
    expect(Number(sub.total)).toBe(22);expect(sub.recordsCount).toBe(1);expect(sub.site).toBe(1);expect(sub.projectId).toBe(1);expect(sub.currentApproverId).toBe(BigInt(pm.id));
    const wb=new ExcelJS.Workbook();await wb.xlsx.load(await storage.read(sub.file.filePath) as unknown as ArrayBuffer);
    expect(wb.worksheets[0].getCell(8,8).value).toBe(22);expect(wb.worksheets[0].getCell(9,8).value).toBeNull();expect(wb.worksheets[0].getCell(10,8).value).toBeNull();
    expect((await prisma.submission.findUniqueOrThrow({where:{id:BigInt(id)}})).revision).toBe(0);expect((await tasks('RESENT')).body.data).toHaveLength(1);
  });
  it.each([
    {qty:'1',price:'100',net:80},
    {qty:'2',price:'100',net:180},
    {qty:'1',price:'120',net:100},
  ])('retains the fixed deduction through saving notes, repeated saves, preview and submit ($qty × $price)',async({qty,price,net})=>{
    const source=new ExcelJS.Workbook();await source.xlsx.load(await file() as unknown as ArrayBuffer);
    const ws=source.worksheets[0];ws.getCell(8,9).value=100;ws.getCell(8,8).value=80;ws.getCell(15,8).value=100;
    ws.getCell(8,2).value='مقاول الخصم\nخصم ثابت';
    const {id,t,d}=await ready('labor',1,Buffer.from(await source.xlsx.writeBuffer()),100);
    const url=`/api/submissions/corrections/drafts/${d.id}`;
    // The browser sends qty/price even when only notes changed.
    for(let version=0;version<2;version++) {
      const saved=await request(app).patch(url).set(auth(eng.token)).send({version,edits:[{taskId:t[0].id,qty,price,notes:'بيان مصحح'}]});
      expect(saved.status,saved.body.message).toBe(200);
    }
    const opened=await request(app).get(url).set(auth(eng.token));
    expect(Number(opened.body.data.total)).toBe(net);expect(opened.body.data.rows[0].discount).toBe('20');
    expect(opened.body.data.rows[0].label).toContain('2026-10-07');
    const preview=await request(app).get(url+'/file').set(auth(eng.token)).buffer(true).parse((res,done)=>{
      const chunks:Buffer[]=[];res.on('data',(chunk:Buffer)=>chunks.push(chunk));res.on('end',()=>done(null,Buffer.concat(chunks)));
    });
    expect(preview.status).toBe(200);
    const check=async(buffer:Buffer)=>{
      const wb=new ExcelJS.Workbook();await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      expect(wb.worksheets[0].getCell(8,8).value).toBe(net);expect(wb.worksheets[0].getCell(15,8).value).toBe(net);
      expect(wb.worksheets[0].getCell(8,3).value).toBe('بيان مصحح');expect(wb.worksheets[0].getCell(8,2).value).toBe('مقاول الخصم\nخصم ثابت');
    };
    await check(preview.body);
    const sent=await send({...d,version:2});expect(sent.status,sent.body.message).toBe(201);
    const replacement=await prisma.submission.findUniqueOrThrow({where:{id:BigInt(sent.body.data.id)},include:{file:true}});
    expect(Number(replacement.total)).toBe(net);await check(await storage.read(replacement.file.filePath));
    const original=await prisma.submission.findUniqueOrThrow({where:{id:BigInt(id)},include:{file:true}});
    const originalWb=new ExcelJS.Workbook();await originalWb.xlsx.load(await storage.read(original.file.filePath) as unknown as ArrayBuffer);
    expect(originalWb.worksheets[0].getCell(8,8).value).toBe(80);
  });
  it('rejects financial changes below the retained deduction without saving or consuming the task',async()=>{
    const source=new ExcelJS.Workbook();await source.xlsx.load(await file() as unknown as ArrayBuffer);
    source.worksheets[0].getCell(8,9).value=100;source.worksheets[0].getCell(8,8).value=80;source.worksheets[0].getCell(15,8).value=100;
    const {t,d}=await ready('labor',1,Buffer.from(await source.xlsx.writeBuffer()),100);
    const r=await request(app).patch(`/api/submissions/corrections/drafts/${d.id}`).set(auth(eng.token)).send({version:0,edits:[{taskId:t[0].id,qty:'0',price:'100'}]});
    expect(r.status).toBe(400);expect(r.body.message).toContain('الخصم الأصلي');
    expect((await prisma.correctionDraft.findUniqueOrThrow({where:{id:BigInt(d.id)}})).version).toBe(0);
    expect((await tasks()).body.summary.days).toBe(1);
  });
  it('concurrent draft creation and submission reserve a single replacement; retry is idempotent',async()=>{
    const id=await submit();await strike(id);await decide(id);const ts=(await tasks()).body.data;
    const ds=await Promise.all([draft([ts[0].id]),draft([ts[0].id])]);expect(ds.map(r=>r.status).sort()).toEqual([201,409]);
    const d=ds.find(r=>r.status===201)!.body.data;
    const sent=await Promise.all([send(d),send(d)]);expect(sent.filter(r=>r.status===201)).toHaveLength(1);expect(sent.every(r=>[200,201,409].includes(r.status))).toBe(true);
    const again=await send(d);expect(again.status).toBe(200);expect(again.body.data.id).toBe(sent.find(r=>r.status===201)!.body.data.id);
    expect(await prisma.correctionLink.count()).toBe(1);expect(await prisma.submission.count()).toBe(2);
    expect((await draft([ts[0].id])).status).toBe(409);
  });
  it('rejecting the replacement reopens the same obligation, and resending it uses the next revision',async()=>{
    const {d}=await ready();const sent=await send(d);const id=sent.body.data.id;
    expect((await decide(id,'REJECTED')).status).toBe(200);expect((await tasks()).body.summary).toEqual({submissions:0,days:1});expect((await tasks()).body.data[0].reason).toBe('عدّل الكشف');expect(await prisma.correctionTask.count()).toBe(1);
    const source=await prisma.submission.findUniqueOrThrow({where:{id:BigInt(id)},include:{file:true}});
    const r=await request(app).post(`/api/submissions/${id}/resend`).set(auth(eng.token)).attach('file',await storage.read(source.file.filePath),'retry.xlsx');expect(r.status,r.body.message).toBe(200);expect(r.body.data.revision).toBe(1);
    expect((await decide(id)).status).toBe(200);expect((await tasks('RESOLVED')).body.data).toHaveLength(1);expect(await prisma.correctionTask.count()).toBe(1);
  });
  it('striking a replacement again never creates a second task',async()=>{
    const {d}=await ready();const sent=await send(d);expect((await strike(sent.body.data.id)).status).toBe(201);
    expect(await prisma.correctionTask.count()).toBe(1);expect((await tasks()).body.summary.days).toBe(1);
    const open=(await tasks()).body.data;const again=await draft([open[0].id]);expect(again.status).toBe(201);
  });
  it('partial replacement approval resolves only the accepted part and reports exclude rejected amounts/days',async()=>{
    const {id,d}=await ready('labor',2);const r=await send(d);const replacement=r.body.data.id;
    expect((await strike(replacement,8)).status).toBe(201);expect((await decide(replacement)).status).toBe(200);
    const all=await prisma.correctionTask.findMany({orderBy:{row:'asc'}});expect(all.map(t=>t.state)).toEqual(['OPEN','RESOLVED']);
    const snapshot=await prisma.submission.findUniqueOrThrow({where:{id:BigInt(replacement)}});expect(Number(snapshot.approvedTotal)).toBe(10);
    await pushSubmissionToSheet(BigInt(id));await pushSubmissionToSheet(BigInt(replacement));
    const totals=await approvedTotalsReport([BigInt(eng.id)],{},'month');expect(totals.totals.total).toBe(20);
    const days=await laborReport([BigInt(eng.id)],{});expect(days.totals.after).toBe(2);expect(days.totals.duplicates).toBe(0);
  });
  it('a legacy approved original with no accounting cache is counted after exclusion, not at gross value',async()=>{
    const {id,d}=await ready();await pushSubmissionToSheet(BigInt(id));
    await prisma.submission.update({where:{id:BigInt(id)},data:{approvedTotal:null}});await prisma.submissionLaborDays.deleteMany({where:{submissionId:BigInt(id)}});
    const sent=await send(d);expect(sent.status,sent.body.message).toBe(201);
    expect(Number((await prisma.submission.findUniqueOrThrow({where:{id:BigInt(id)}})).approvedTotal)).toBe(20);
    await decide(sent.body.data.id);
    const totals=await approvedTotalsReport([BigInt(eng.id)],{},'month');expect(totals.totals.total).toBe(30);
    const days=await laborReport([BigInt(eng.id)],{});expect(days.totals.after).toBe(3);expect(days.totals.duplicates).toBe(0);
  });
  it('full rejection plus row correction resends through the existing endpoint without copying FINAL rows',async()=>{
    const id=await submit();await strike(id,8);await strike(id,9,'FINAL');await decide(id,'REJECTED');
    const bad=await request(app).post(`/api/submissions/${id}/resend`).set(auth(eng.token)).attach('file',await file(),'bad.xlsx');expect(bad.status).toBe(400);
    await prisma.submission.update({where:{id:BigInt(id)},data:{gsheetRow:12,gdriveFileId:'legacy-test-reference'}});
    const fileBuffer=await file('labor',[8,10]);
    const responses=await Promise.all([1,2].map(()=>request(app).post(`/api/submissions/${id}/resend`).set(auth(eng.token)).attach('file',fileBuffer,'retry.xlsx')));
    expect(responses.every(r=>[200,400,409].includes(r.status))).toBe(true);
    expect((await decide(id)).status).toBe(200);
    expect((await tasks()).body.summary).toEqual({submissions:0,days:0});
    expect((await tasks('RESOLVED')).body.data).toHaveLength(2);
    expect(await prisma.submissionRevision.count()).toBe(1);
    const archived=await prisma.submissionRevision.findFirstOrThrow();expect(archived.gsheetRow).toBe(12);expect(archived.gdriveFileId).toBe('legacy-test-reference');
    expect((await prisma.submission.findUniqueOrThrow({where:{id:BigInt(id)}})).gsheetRow).toBeNull();
    expect(responses.map(r=>r.status).filter(s=>s===200)).toHaveLength(1);
  });
  it('a whole obligation stays under review until its re-struck part is actually approved',async()=>{
    const id=await submit();await decide(id,'REJECTED');
    expect((await tasks()).body.summary.submissions).toBe(1);
    const resent=await request(app).post(`/api/submissions/${id}/resend`).set(auth(eng.token)).attach('file',await file(),'whole.xlsx');expect(resent.status).toBe(200);
    await strike(id,8);await decide(id);
    expect((await tasks('RESENT')).body.data.filter((t:{row:number})=>t.row===0)).toHaveLength(1);
    const open=(await tasks()).body.data;expect(open).toHaveLength(1);
    const d=(await draft([open[0].id])).body.data;const sent=await send(d);await decide(sent.body.data.id);
    expect((await tasks('RESENT')).body.data).toHaveLength(0);expect((await tasks('RESOLVED')).body.data).toHaveLength(2);
  });
  it('resend maps days by archived source identity when Excel rows move',async()=>{
    const id=await submit();await strike(id,8);await decide(id,'REJECTED');
    const changed=await request(app).post(`/api/submissions/${id}/resend`).set(auth(eng.token)).attach('file',await file('labor',[10,11,12],true),'moved.xlsx');expect(changed.status,changed.body.message).toBe(200);
    const link=await prisma.correctionLink.findFirstOrThrow({where:{row:{gt:0}}});expect(link.row).toBe(10);
    expect((await strike(id,10)).status).toBe(201);await decide(id);
    expect(await prisma.correctionTask.count()).toBe(2);expect((await tasks()).body.summary.days).toBe(1);
    const t=(await tasks()).body.data;const d=(await draft([t[0].id])).body.data;const sent=await send(d);await decide(sent.body.data.id);
    expect((await tasks('RESENT')).body.data).toHaveLength(0);expect((await tasks('RESOLVED')).body.data).toHaveLength(2);
  });
  it.each(['labor','equipment'])('matches %s corrections by full date, never the same weekday next week',async(kind)=>{
    const id=await submit(kind);await strike(id,8);await decide(id,'REJECTED');
    const endpoint=`/api/submissions/${id}/resend`;
    const wrong=await request(app).post(endpoint).set(auth(eng.token)).attach('file',await file(kind,[10],false,['2026-10-14']),'wrong-week.xlsx');
    expect(wrong.status,wrong.body.message).toBe(409);expect(await prisma.submissionRevision.count()).toBe(0);
    const correct=await request(app).post(endpoint).set(auth(eng.token)).attach('file',await file(kind,[10],false,['2026-10-07']),'moved.xlsx');
    expect(correct.status,correct.body.message).toBe(200);
    const link=await prisma.correctionLink.findFirstOrThrow({where:{row:{gt:0}}});expect(link.row).toBe(10);
  });
  it.each(['labor','equipment'])('applies FINAL exclusions to the exact %s date even when rows move',async(kind)=>{
    const id=await submit(kind);await strike(id,8,'FINAL');await strike(id,9);await decide(id,'REJECTED');
    const endpoint=`/api/submissions/${id}/resend`;
    const same=await request(app).post(endpoint).set(auth(eng.token)).attach('file',await file(kind,[10,11],false,['2026-10-08','2026-10-07']),'excluded.xlsx');
    expect(same.status).toBe(400);expect(same.body.message).toContain('مستبعدًا نهائيًا');
    const different=await request(app).post(endpoint).set(auth(eng.token)).attach('file',await file(kind,[10,11],false,['2026-10-08','2026-10-14']),'next-week.xlsx');
    expect(different.status,different.body.message).toBe(200);
    expect((await prisma.correctionLink.findFirstOrThrow({where:{row:{gt:0}}})).row).toBe(10);
  });
  it.each(['labor','equipment'])('refuses an unreliable %s date on either side of a resend match',async(kind)=>{
    const id=await submit(kind);await strike(id,8);await decide(id,'REJECTED');
    const endpoint=`/api/submissions/${id}/resend`;
    for(const date of [null,'الأربعاء','2026-02-30','2026-10-07 extra',{formula:'"2026-10-07"',result:'2026-10-07'}]) {
      const r=await request(app).post(endpoint).set(auth(eng.token)).attach('file',await file(kind,[10],false,[date]),'invalid.xlsx');
      expect(r.status,r.body.message).toBe(400);expect(r.body.message).toContain('التاريخ');
    }
    // The archived/source weekday must not rescue a missing or invalid actual date.
    const sub=await prisma.submission.findUniqueOrThrow({where:{id:BigInt(id)},include:{file:true}});
    const wb=new ExcelJS.Workbook();await wb.xlsx.load(await storage.read(sub.file.filePath) as unknown as ArrayBuffer);
    wb.worksheets[0].getCell(8,kind==='labor'?12:13).value='2026-02-30';
    const stored=await storage.save(Buffer.from(await wb.xlsx.writeBuffer()),'bad-source.xlsx');
    await prisma.file.update({where:{id:sub.fileId},data:{filePath:stored.storedPath}});
    const r=await request(app).post(endpoint).set(auth(eng.token)).attach('file',await file(kind,[10],false,['2026-10-07']),'valid.xlsx');
    expect(r.status,r.body.message).toBe(400);expect(await prisma.submissionRevision.count()).toBe(0);
  });
  it('normalizes actual Excel date cells and rejects impossible or ambiguous dates',()=>{
    const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('dates');
    ws.getCell(8,12).value=new Date('2026-10-07T00:00:00Z');ws.getCell(8,13).value='الأربعاء';
    expect(rowDate(ws,8,'labor')).toBe('2026-10-07');
    ws.getCell(8,12).value='2026-02-29';expect(rowDate(ws,8,'labor')).toBeNull();
    ws.getCell(8,12).value='2028-02-29';expect(rowDate(ws,8,'labor')).toBe('2028-02-29');
    ws.getCell(8,12).value='07/10/2026';expect(rowDate(ws,8,'labor')).toBeNull();
    ws.getCell(8,12).value=null;ws.getCell(8,13).value='2026-10-07';expect(rowDate(ws,8,'labor')).toBeNull();
    expect(rowDate(ws,8,'equipment')).toBe('2026-10-07');
  });
  it('stale draft edits conflict and invalid financial input never consumes a request',async()=>{
    const {d,t}=await ready();
    const url=`/api/submissions/corrections/drafts/${d.id}`;
    const bad=await request(app).patch(url).set(auth(eng.token)).send({version:0,edits:[{taskId:t[0].id,qty:'-1'}]});expect(bad.status).toBe(400);
    const edits={version:0,edits:[{taskId:t[0].id,qty:'2',price:'10'}]};
    const results=await Promise.all([request(app).patch(url).set(auth(eng.token)).send(edits),request(app).patch(url).set(auth(eng.token)).send(edits)]);expect(results.map(r=>r.status).sort()).toEqual([200,409]);
    expect((await send(d)).status).toBe(409);expect((await tasks()).body.summary.days).toBe(1);expect(await prisma.correctionLink.count()).toBe(0);
  });
  it('storage failure leaves the request open and allows a later retry',async()=>{
    const {d}=await ready();const before=await prisma.file.count();
    const fail=vi.spyOn(storage,'save').mockRejectedValueOnce(new Error('storage unavailable'));
    const log=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    try{expect((await send(d)).status).toBe(500);}finally{fail.mockRestore();log.mockRestore();}
    expect(await prisma.file.count()).toBe(before);expect(await prisma.submission.count()).toBe(1);expect(await prisma.correctionLink.count()).toBe(0);expect((await tasks()).body.summary.days).toBe(1);
    expect((await send(d)).status).toBe(201);
  });
  it('a transaction failure after reservation rolls back all writes and removes the orphan file',async()=>{
    const {d}=await ready();const before=await prisma.file.count();
    const transaction=prisma.$transaction.bind(prisma);
    const mock=vi.spyOn(prisma,'$transaction').mockImplementation(((fn: unknown)=>{
      if (Array.isArray(fn)) return transaction(fn); // normal background accounting may finish concurrently
      return transaction(async tx=>{const result=await (fn as (client: unknown)=>Promise<unknown>)(tx);if(typeof result==='bigint')throw new Error('injected failure after writes');return result;});
    }) as never);
    const removed=vi.spyOn(storage,'remove');const log=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    try{expect((await send(d)).status).toBe(500);expect(removed).toHaveBeenCalledTimes(1);}
    finally{mock.mockRestore();removed.mockRestore();log.mockRestore();}
    expect(await prisma.file.count()).toBe(before);expect(await prisma.submission.count()).toBe(1);expect(await prisma.correctionLink.count()).toBe(0);expect((await tasks()).body.summary.days).toBe(1);
    expect((await send(d)).status).toBe(201);
  });
  it('days from different sources cannot be merged and no-approval projects use their existing policy',async()=>{
    const a=await submit();await strike(a);await decide(a);const b=await submit();await strike(b);await decide(b);
    const ts=(await tasks()).body.data;expect((await draft(ts.map((t:{id:string})=>t.id))).status).toBe(400);
    const d=(await draft([ts[0].id])).body.data;
    await prisma.project.update({where:{id:1},data:{noApproval:true}});
    try{const r=await send(d);expect(r.status).toBe(201);const sub=await prisma.submission.findUniqueOrThrow({where:{id:BigInt(r.body.data.id)}});expect(sub.reviewState).toBe('SENT');expect((await tasks('RESOLVED')).body.data).toHaveLength(1);}
    finally{await prisma.project.update({where:{id:1},data:{noApproval:false}});}
  });
  it('legacy admin rejection creates a normal full obligation and status changes cannot hide it',async()=>{
    const id=await submit();
    const rejected=await request(app).patch(`/api/submissions/${id}/review`).set(auth(admin.token)).send({status:'REJECTED',reviewNote:'رفض الإدارة'});expect(rejected.status).toBe(200);
    expect((await tasks()).body.summary.submissions).toBe(1);
    await request(app).patch(`/api/submissions/${id}/review`).set(auth(admin.token)).send({status:'SUBMITTED'});
    expect((await tasks()).body.summary.submissions).toBe(1);
    const sent=await request(app).post(`/api/submissions/${id}/resend`).set(auth(eng.token)).attach('file',await file(),'retry.xlsx');expect(sent.status).toBe(200);expect(sent.body.data.status).toBe('SUBMITTED');expect(sent.body.data.reviewNote).toBeNull();
  });
  it('equipment preserves merged place/time cells and recalculates operating hours',async()=>{
    const {t,d}=await ready('equipment');const patch=await request(app).patch(`/api/submissions/corrections/drafts/${d.id}`).set(auth(eng.token)).send({version:0,edits:[{taskId:t[0].id,timeFrom:'08:00',timeTo:'11:30',notes:'تشغيل مصحح'}]});expect(patch.status,patch.body.message).toBe(200);
    const r=await send({...d,version:1});expect(r.status,r.body.message).toBe(201);
    const sub=await prisma.submission.findUniqueOrThrow({where:{id:BigInt(r.body.data.id)},include:{file:true}});expect(Number(sub.total)).toBe(3.5);
    const wb=new ExcelJS.Workbook();await wb.xlsx.load(await storage.read(sub.file.filePath) as unknown as ArrayBuffer);
    expect(wb.worksheets[0].getCell(8,7).value).toBe('3:30');expect(wb.worksheets[0].getCell(8,10).value).toBe('مكان');expect(wb.worksheets[0].getCell(9,7).value).toBeNull();
  });
  it('missing source files fail explicitly without losing the request or creating a draft',async()=>{
    const {id,d}=await ready();await request(app).delete(`/api/submissions/corrections/drafts/${d.id}`).set(auth(eng.token));
    const sub=await prisma.submission.findUniqueOrThrow({where:{id:BigInt(id)},include:{file:true}});await storage.remove(sub.file.filePath);
    const t=(await tasks()).body.data;expect((await draft([t[0].id])).status).toBe(404);expect((await tasks()).body.summary.days).toBe(1);expect(await prisma.correctionDraft.count()).toBe(0);
  });
  it('manager filters and direct API calls enforce permissions, including draft ownership',async()=>{
    const {d}=await ready();
    expect((await request(app).get(`/api/submissions/corrections/drafts/${d.id}`).set(auth(other.token))).status).toBe(404);
    expect((await request(app).post(`/api/submissions/corrections/drafts/${d.id}/submit`).set(auth(other.token)).send({version:0})).status).toBe(404);
    expect((await request(app).get('/api/approvals/corrections').set(auth(eng.token))).status).toBe(403);
    const filter='/api/approvals/corrections?ownerSearch=missing&projectId=1&minAgeHours=0';expect((await request(app).get(filter).set(auth(pm.token))).body.total).toBe(0);
    expect((await request(app).get('/api/approvals/corrections?ownerSearch=eng@&projectId=1').set(auth(pm.token))).body.total).toBe(1);
    const id=(await prisma.correctionTask.findFirstOrThrow()).sourceId;
    expect((await request(app).delete(`/api/submissions/${id}`).set(auth(admin.token))).status).toBe(409);
    expect((await request(app).delete(`/api/admin/users/${eng.id}`).set(auth(admin.token)).send({confirmEmail:eng.email})).status).toBe(409);
  });
  it('late Google responses link the archived revision and never replace the new version links',async()=>{
    const id=await submit();await prisma.submission.update({where:{id:BigInt(id)},data:{reviewState:'SENT',currentLevel:null,currentApproverId:null}});
    let release!:()=>void,started!:()=>void;const pendingReply=new Promise<void>(resolve=>release=resolve);const called=new Promise<void>(resolve=>started=resolve);
    vi.stubEnv('GOOGLE_WEBAPP_URL','https://google.example.test/exec');vi.stubEnv('GOOGLE_WEBAPP_SECRET','test-only-binding');
    const fetchMock=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{started();await pendingReply;return new Response(JSON.stringify({ok:true,row:77,fileId:'old-revision-test-file'}),{status:200});});
    const push=google.pushSubmissionToGoogle(BigInt(id),await file(),'old.xlsx','engineer',null,1,'','labor',0);
    try{
      await called;
      await request(app).patch(`/api/submissions/${id}/review`).set(auth(admin.token)).send({status:'REJECTED',reviewNote:'رفض حقيقي بعد الاعتماد'});
      const resent=await request(app).post(`/api/submissions/${id}/resend`).set(auth(eng.token)).attach('file',await file(),'new.xlsx');expect(resent.status).toBe(200);
      release();await push;
      const current=await prisma.submission.findUniqueOrThrow({where:{id:BigInt(id)}});expect(current.revision).toBe(1);expect(current.gsheetRow).toBeNull();
      const old=await prisma.submissionRevision.findFirstOrThrow();expect(old.gsheetRow).toBe(77);expect(old.gdriveFileId).toBe('old-revision-test-file');
      await google.pushSubmissionToGoogle(BigInt(id),await file(),'obsolete.xlsx','engineer',null,1,'','labor',0);expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((await request(app).post(`/api/submissions/${id}/gsync`).set(auth(admin.token))).status).toBe(400);expect(fetchMock).toHaveBeenCalledTimes(1);
    }finally{release();await push;fetchMock.mockRestore();vi.unstubAllEnvs();}
  });
  it('stale background labor-day calculations cannot overwrite a newer revision',async()=>{
    const id=await submit();await prisma.submission.update({where:{id:BigInt(id)},data:{reviewState:'SENT',revision:1}});
    await prisma.submissionLaborDays.create({data:{submissionId:BigInt(id),contractorName:'مقاول',days:5}});
    await saveLaborDays(BigInt(id),new Map([['مقاول',1]]),0);
    expect(Number((await prisma.submissionLaborDays.findFirstOrThrow()).days)).toBe(5);
    await saveLaborDays(BigInt(id),new Map([['مقاول',2]]),1);
    expect(Number((await prisma.submissionLaborDays.findFirstOrThrow()).days)).toBe(2);
  });
  it('Google failure after approval never reopens a correction obligation',async()=>{
    const {d}=await ready();const r=await send(d);
    const mock=vi.spyOn(google,'pushSubmissionToGoogle').mockRejectedValue(new Error('temporary network failure'));
    const log=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    try {expect((await decide(r.body.data.id)).status).toBe(200);expect((await tasks('RESOLVED')).body.data).toHaveLength(1);expect((await tasks()).body.summary.days).toBe(0);}
    finally {await new Promise(resolve=>setTimeout(resolve,100));mock.mockRestore();log.mockRestore();}
  });
});
