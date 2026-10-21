import { Prisma, Submission } from '@prisma/client';
import ExcelJS from 'exceljs';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { storage } from './storage';
import { dataRowsOf, Kind, readLaborRow } from './rowReject';
import { validateWorkbook } from './workbookSafety';

type Tx = Prisma.TransactionClient;
export type RowEditInput = { taskId: string; qty?: string; price?: string; notes?: string; timeFrom?: string; timeTo?: string };
export const conflict = () => AppError.conflict('حالة التصحيح اتغيّرت أو له إرسال نشط — حدّث القائمة');

export async function audit(tx: Tx, taskId: bigint, actorId: bigint | null, action: string, detail: string) {
  await tx.correctionEvent.create({ data: { taskId, actorId, action, detail: detail.slice(0, 1000) } });
}

// Serialize all state changes with the same row lock, including approvals and resends.
export async function lockSubmission(tx: Tx, id: bigint) {
  await tx.$queryRaw`SELECT id FROM submissions WHERE id = ${id} FOR UPDATE`;
}

export async function returned(tx: Tx, sub: Submission, actorId: bigint | null, reason: string) {
  const links = await tx.correctionLink.findMany({ where: { replacementId: sub.id, revision: sub.revision, activeTaskId: { not: null } } });
  if (links.length) {
    for (const link of links) {
      await tx.correctionTask.update({ where: { id: link.taskId }, data: { state: 'OPEN', resolvedAt: null, reason, requestedById: actorId } });
      await tx.correctionLink.update({ where: { id: link.id }, data: { activeTaskId: null } });
      await audit(tx, link.taskId, actorId, 'RETURNED', reason);
    }
    return;
  }
  const task = await tx.correctionTask.upsert({
    where: { sourceId_sourceRevision_sheetIndex_row: { sourceId: sub.id, sourceRevision: sub.revision, sheetIndex: -1, row: 0 } },
    create: { sourceId: sub.id, sourceRevision: sub.revision, sheetIndex: -1, row: 0, ownerId: sub.userId, requestedById: actorId, reason },
    update: { reason, requestedById: actorId },
  });
  await audit(tx, task.id, actorId, 'REQUESTED', reason);
}

export async function classified(tx: Tx, sub: Submission, actorId: bigint, sheetIndex: number, row: number, note: string, legacyReview = false) {
  // A re-struck correction is the same obligation, not a second payable claim.
  const link = await tx.correctionLink.findFirst({ where: { replacementId: sub.id, revision: sub.revision, sheetIndex, row, activeTaskId: { not: null } } });
  if (link) {
    await tx.correctionTask.update({ where: { id: link.taskId }, data: { reason: note, requestedById: actorId } });
    await audit(tx, link.taskId, actorId, 'STRUCK_AGAIN', note);
    return;
  }
  const task = await tx.correctionTask.upsert({
    where: { sourceId_sourceRevision_sheetIndex_row: { sourceId: sub.id, sourceRevision: sub.revision, sheetIndex, row } },
    create: { sourceId: sub.id, sourceRevision: sub.revision, sheetIndex, row, ownerId: sub.userId, reason: note, requestedById: actorId, legacyReview },
    update: {},
  });
  await audit(tx, task.id, actorId, 'CLASSIFIED_CORRECTION', note);
}

// Called in the approval transaction, before external file generation / Google I/O.
export async function completed(tx: Tx, sub: Submission, actorId: bigint | null) {
  const links = await tx.correctionLink.findMany({ where: { replacementId: sub.id, revision: sub.revision, activeTaskId: { not: null } } });
  const strikes = await tx.submissionRowRejection.findMany({ where: { submissionId: sub.id, revision: sub.revision } });
  for (const link of links) {
    const rejected = link.row !== 0 && strikes.some((s) => s.sheetIndex === link.sheetIndex && s.row === link.row);
    if (link.row === 0 && (await tx.correctionTask.count({ where: { sourceId: sub.id, sourceRevision: sub.revision, row: { gt: 0 }, state: { not: 'RESOLVED' } } }) || await tx.correctionLink.count({ where: { replacementId: sub.id, revision: sub.revision, row: { gt: 0 }, task: { state: { not: 'RESOLVED' } } } }))) continue;
    await tx.correctionTask.update({ where: { id: link.taskId }, data: { state: rejected ? 'OPEN' : 'RESOLVED', resolvedAt: rejected ? null : new Date() } });
    await tx.correctionLink.update({ where: { id: link.id }, data: { activeTaskId: null } });
    await audit(tx, link.taskId, actorId, rejected ? 'STRUCK_AGAIN' : 'RESOLVED', `submission ${sub.id} revision ${sub.revision}`);
  }
  const sourceIds = await tx.correctionTask.findMany({ where: { id: { in: links.map((l) => l.taskId) } }, select: { sourceId: true, sourceRevision: true } });
  for (const source of sourceIds) {
    if (await tx.correctionTask.count({ where: { sourceId: source.sourceId, sourceRevision: source.sourceRevision, row: { gt: 0 }, state: { not: 'RESOLVED' } } })) continue;
    const parents = await tx.correctionLink.findMany({ where: { replacementId: source.sourceId, row: 0, activeTaskId: { not: null } } });
    const parentSub = await tx.submission.findUnique({ where: { id: source.sourceId } });
    if (parentSub?.reviewState !== 'SENT') continue;
    for (const parent of parents) {
      if (parent.revision !== parentSub.revision || await tx.correctionTask.count({ where: { sourceId: parentSub.id, sourceRevision: parent.revision, row: { gt: 0 }, state: { not: 'RESOLVED' } } }) || await tx.correctionLink.count({ where: { replacementId: parentSub.id, revision: parent.revision, row: { gt: 0 }, task: { state: { not: 'RESOLVED' } } } })) continue;
      await tx.correctionTask.update({ where: { id: parent.taskId }, data: { state: 'RESOLVED', resolvedAt: new Date() } });
      await tx.correctionLink.update({ where: { id: parent.id }, data: { activeTaskId: null } });
      await audit(tx, parent.taskId, actorId, 'RESOLVED', 'All corrected parts approved');
    }
  }
}

export async function workbook(buffer: Buffer) {
  await validateWorkbook(buffer);
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer as unknown as ArrayBuffer); } catch { throw AppError.validation('تعذّرت قراءة ملف المصدر — لا يمكن إنشاء كشف ناقص'); }
  return wb;
}

export async function sourceWorkbook(sourceId: bigint, revision: number) {
  const sub = await prisma.submission.findUnique({ where: { id: sourceId }, include: { file: true } });
  if (!sub) throw AppError.notFound('الكشف الأصلي غير موجود');
  const file = sub.revision === revision ? sub.file : (await prisma.submissionRevision.findUnique({ where: { submissionId_revision: { submissionId: sourceId, revision } }, include: { file: true } }))?.file;
  const buffer = file && await storage.read(file.filePath).catch(() => null);
  if (!buffer) throw AppError.notFound('ملف نسخة المصدر غير موجود — يلزم مراجعة المسؤول');
  return { sub, wb: await workbook(buffer) };
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((v) => v.text).join('');
    if ('result' in value) return String(value.result ?? '');
    throw AppError.validation('صيغة خلية غير مدعومة في كشف التصحيح');
  }
  return String(value).replace(/\u200f/g, '').trim();
}
function decimal(value: string, amount = false) {
  const pattern = amount ? /^\d{1,10}(\.\d{1,2})?$/ : /^\d{1,8}(\.\d{1,2})?$/;
  if (!pattern.test(value)) throw AppError.validation('العدد والسعر لازم يكونوا أرقام موجبة بدقة خانتين');
  return new Prisma.Decimal(value);
}
function time(value: string) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw AppError.validation('الوقت غير صحيح');
  const [h, m] = value.split(':').map(Number); return h * 60 + m;
}

// Immutable source coordinates stay unchanged in every draft. Empty sheets are removed only
// after recording the explicit source -> replacement sheet mapping.
export async function buildDraft(sourceId: bigint, revision: number, ids: bigint[], edits: RowEditInput[]) {
  const { sub, wb } = await sourceWorkbook(sourceId, revision);
  const tasks = await prisma.correctionTask.findMany({ where: { id: { in: ids }, sourceId, sourceRevision: revision, row: { gt: 0 } } });
  if (tasks.length !== ids.length) throw AppError.validation('الأيام لا تنتمي لنفس الكشف ونسخته');
  const kind = sub.kind as Kind;
  const selected = new Set(tasks.map((t) => `${t.sheetIndex}:${t.row}`));
  let total = new Prisma.Decimal(0), recordsCount = 0;
  const mapping: Array<{ taskId: bigint; sheetIndex: number; row: number }> = [];
  const details: Array<Record<string, unknown>> = [];
  const kept: ExcelJS.Worksheet[] = [];
  for (const [index, ws] of [...wb.worksheets].entries()) {
    const allRows = dataRowsOf(ws, kind);
    const rows = allRows.filter((r) => selected.has(`${index}:${r}`));
    if (!rows.length) { wb.removeWorksheet(ws.id); continue; }
    const targetSheet = kept.length; kept.push(ws);
    // Original file has no server stamps, but remove embedded images / signature captions
    // from signature blocks defensively. New approvals stamp only this revision.
    (ws as unknown as { _media: unknown[] })._media = [];
    for (let r = 16; r <= 22; r++) for (let c = 1; c <= 13; c++) {
      const cell = ws.getCell(r, c);
      if (Number(cell.master.row) === r && Number(cell.master.col) === c && !cellText(cell.value).includes('توقيع')) cell.value = null;
    }
    for (let r = 8; r <= (kind === 'equipment' ? 12 : 14); r++) {
      if (!rows.includes(r)) { for (let c = 1; c <= 11; c++) ws.getCell(r, c).value = null; continue; }
      const task = tasks.find((t) => t.sheetIndex === index && t.row === r)!;
      const edit = edits.find((e) => e.taskId === String(task.id));
      if (kind === 'labor') {
        const current = readLaborRow(ws, r);
        if ((edit?.qty !== undefined || edit?.price !== undefined) && (current.multi || current.qty == null || current.price == null)) throw AppError.validation('اليوم يحتوي سجلات متعددة أو قيمًا غير قابلة للتحرير — عدّل البيان فقط أو راجع المسؤول');
        if (edit?.qty !== undefined || edit?.price !== undefined) {
          const q = decimal(edit.qty ?? String(current.qty));
          const p = decimal(edit.price ?? String(current.price));
          ws.getCell(r, 11).value = `${q} ${current.qtyType}`;
          ws.getCell(r, 9).value = p.toNumber();
          const amount = q.mul(p).toDecimalPlaces(2);
          if (amount.greaterThan('9999999999.99')) throw AppError.validation('قيمة اليوم أكبر من الحد المالي المدعوم');
          ws.getCell(r, 8).value = amount.toNumber();
        }
        if (edit?.notes !== undefined) ws.getCell(r, 3).value = edit.notes;
        total = total.add(decimal(cellText(ws.getCell(r, 8).value), true));
        details.push({ taskId: String(task.id), label: `${ws.name} — ${cellText(ws.getCell(r, 13).value)}`, qty: current.multi ? null : current.qty, price: current.multi ? null : current.price, notes: cellText(ws.getCell(r, 3).value), ...edit });
      } else {
        // Equipment layout: H:I = time range, J:K = place, G = duration.
        const range = cellText(ws.getCell(r, 8).value);
        const times = range.match(/^(\d{2}:\d{2})\s*[–-]\s*(\d{2}:\d{2})$/);
        if (edit?.timeFrom !== undefined || edit?.timeTo !== undefined) {
          if (!times) throw AppError.validation('يوم المعدات يحتوي أوقاتًا متعددة — عدّل الملاحظات فقط أو راجع المسؤول');
          const from = edit.timeFrom ?? times[1];
          const to = edit.timeTo ?? times[2];
          const minutes = (time(to) - time(from) + 1440) % 1440;
          ws.getCell(r, 8).value = `${from} – ${to}`;
          ws.getCell(r, 7).value = `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
        }
        if (edit?.notes !== undefined) ws.getCell(r, 1).value = edit.notes;
        const duration = cellText(ws.getCell(r, 7).value).match(/^(\d+):(\d{2})$/);
        if (!duration) throw AppError.validation('مدة المعدات غير قابلة للقراءة');
        total = total.add(Number(duration[1]) * 60 + Number(duration[2]));
        details.push({ taskId: String(task.id), label: `${ws.name} — ${cellText(ws.getCell(r, 13).value)}`, timeFrom: times?.[1] ?? null, timeTo: times?.[2] ?? null, notes: cellText(ws.getCell(r, 1).value), ...edit });
      }
      recordsCount++;
      mapping.push({ taskId: task.id, sheetIndex: targetSheet, row: r });
    }
    if (kind === 'labor') {
      let sum = new Prisma.Decimal(0);
      for (const r of rows) sum = sum.add(decimal(cellText(ws.getCell(r, 8).value), true));
      ws.getCell(15, 8).value = sum.toNumber();
    } else {
      let minutes = 0;
      for (const r of rows) { const [h, m] = cellText(ws.getCell(r, 7).value).split(':').map(Number); minutes += h * 60 + m; }
      ws.getCell(13, 7).value = `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
      ws.getCell(13, 6).value = 'كشف تصحيح — أيام المصدر المحددة فقط';
    }
  }
  if (total.greaterThan('9999999999.99')) throw AppError.validation('إجمالي التصحيح أكبر من الحد المدعوم');
  if (mapping.length !== tasks.length) throw AppError.validation('صف المصدر مفقود أو ليس يوم بيانات — يلزم مراجعة المسؤول');
  return { sub, buffer: Buffer.from(await wb.xlsx.writeBuffer()), total: kind === 'equipment' ? total.div(60).toDecimalPlaces(2) : total, recordsCount, mapping, details };
}

export async function assertOpen(tx: Tx, ids: bigint[], sourceId: bigint, ownerId: bigint) {
  // Lock source first, then tasks in stable ID order. Every competing submit uses this lock.
  await lockSubmission(tx, sourceId);
  const source = await tx.submission.findUnique({ where: { id: sourceId } });
  if (!source || source.userId !== ownerId) throw AppError.notFound('الكشف غير موجود');
  if (source.reviewState !== 'SENT') throw AppError.conflict('انتظر اكتمال مراجعة الأصل، أو استخدم تعديل وإعادة إرسال الكشف المرفوض');
  const tasks = await tx.correctionTask.findMany({ where: { id: { in: ids }, sourceId, ownerId, state: 'OPEN', row: { gt: 0 } } });
  if (tasks.length !== ids.length) throw conflict();
  if (await tx.correctionLink.count({ where: { activeTaskId: { in: ids } } })) throw conflict();
  const dispositions = await tx.submissionRowRejection.findMany({ where: { submissionId: sourceId, revision: { in: tasks.map((t) => t.sourceRevision) } } });
  if (tasks.some((t) => !dispositions.some((r) => r.revision === t.sourceRevision && r.sheetIndex === t.sheetIndex && r.row === t.row && r.disposition === 'CORRECTION'))) throw conflict();
  return source;
}

// Keep the existing whole-submission resend endpoint; bind its versioned obligations atomically.
export async function prepareResend(sub: Submission, buffer: Buffer) {
  const tasks = await prisma.correctionTask.findMany({ where: { sourceId: sub.id, state: 'OPEN' } });
  // A returned replacement reuses its original obligations.
  const attempts = await prisma.correctionLink.findMany({ where: { replacementId: sub.id, revision: sub.revision }, include: { task: true } });
  for (const link of attempts) if (link.task.state === 'OPEN' && !tasks.some((t) => t.id === link.taskId)) tasks.push(link.task);
  const strikes = await prisma.submissionRowRejection.findMany({ where: { submissionId: sub.id, OR: [{ revision: sub.revision }, { disposition: 'FINAL' }] } });
  const needsMapping = tasks.some((t) => t.row > 0) || strikes.some((r) => r.disposition === 'FINAL');
  if (!needsMapping) return tasks.map((t) => ({ taskId: t.id, sheetIndex: -1, row: 0 }));
  const old = await sourceWorkbook(sub.id, sub.revision);
  const currentFinal = strikes.filter((r) => r.revision === sub.revision && r.disposition === 'FINAL');
  if (!tasks.length && currentFinal.length > 0 && currentFinal.length === old.wb.worksheets.reduce((n, ws) => n + dataRowsOf(ws, sub.kind as Kind).length, 0)) throw AppError.conflict('كل أيام الكشف مستبعدة نهائيًا — لا يُعاد إرسال هذا الكشف');
  const originals = new Map<string, Awaited<ReturnType<typeof sourceWorkbook>>>([[`${sub.id}:${sub.revision}`, old]]);
  async function getOriginal(id: bigint, revision: number) {
    const cacheKey = `${id}:${revision}`;
    let value = originals.get(cacheKey);
    if (!value) { value = await sourceWorkbook(id, revision); originals.set(cacheKey, value); }
    return value;
  }
  const next = await workbook(buffer);
  const key = (ws: ExcelJS.Worksheet, row: number) => JSON.stringify([cellText(ws.getCell(3, 10).value), cellText(ws.getCell(4, 10).value), ...(sub.kind === 'equipment' ? [cellText(ws.getCell(3, 4).value), cellText(ws.getCell(row, 10).value)] : []), cellText(ws.getCell(row, 13).value)]);
  const positions = next.worksheets.flatMap((ws, sheetIndex) => dataRowsOf(ws, sub.kind as Kind).map((row) => ({ sheetIndex, row, key: key(ws, row) })));
  for (const strike of strikes.filter((r) => r.disposition === 'FINAL')) {
    const archived = await getOriginal(sub.id, strike.revision);
    const ws = archived.wb.worksheets[strike.sheetIndex];
    if (ws && positions.some((p) => p.key === key(ws, strike.row))) throw AppError.validation('الكشف يحتوي يومًا مستبعدًا نهائيًا — احذفه من النسخة الجديدة');
  }
  const mapping = [];
  for (const task of tasks) {
    let sheetIndex = -1, row = 0;
    if (task.row > 0) {
      const original = await getOriginal(task.sourceId, task.sourceRevision);
      const ws = original.wb.worksheets[task.sheetIndex];
      const match = ws ? positions.filter((p) => p.key === key(ws, task.row)) : [];
      if (match.length !== 1) throw AppError.conflict('تعذّر ربط يوم التصحيح بالنسخة الجديدة بشكل موثوق — راجع اليوم والمقاول والمكان');
      ({ sheetIndex, row } = match[0]);
    }
    mapping.push({ taskId: task.id, sheetIndex, row });
  }
  return mapping;
}
export async function linkResend(tx: Tx, sub: Submission, actorId: bigint, mapping: Array<{ taskId: bigint; sheetIndex: number; row: number }>) {
  for (const map of mapping) {
    const changed = await tx.correctionTask.updateMany({ where: { id: map.taskId, state: 'OPEN' }, data: { state: 'RESENT', resentAt: new Date() } });
    if (!changed.count) throw conflict();
    await tx.correctionLink.create({ data: { ...map, activeTaskId: map.taskId, replacementId: sub.id, revision: sub.revision + 1 } });
    await audit(tx, map.taskId, actorId, 'RESENT', `submission ${sub.id} revision ${sub.revision + 1}`);
  }
}
