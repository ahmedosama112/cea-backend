import ExcelJS from 'exceljs';

// ═══════════ شطب سطر من الكشف (رفض جزئي) ═══════════
// المعتمد يشطب سطر يوم معيّن بدل ما يرفض الكشف كله: السطر بيتلوّن أحمر بخط في النص، إجماليه يبقى صفر،
// السبب بيتكتب في خانة الملاحظات، وإجمالي الورقة بيتعاد حسابه. الكشف يكمّل السلسلة ويوصل الـ DC مشطوب.
// التخطيط معروف من الواجهة (buildApprovedSheet / buildEquipmentSheet):
//   العمالة:  صفوف الأيام 8..14، التاريخ عمود 13، إجمالي السطر عمود 8، بيان الأعمال (مدموج 3..7) → الملاحظة في 3، إجمالي الورقة صف 15 عمود 8
//   المعدات:  صفوف الأيام 8..12، التاريخ عمود 13، المدة عمود 7 ("h:mm")، الملاحظات عمود 1، إجمالي الورقة صف 13 عمود 7، إجمالي الشهر صف 13 عمود 6

export type Kind = 'labor' | 'equipment';
export type RowRejection = { sheetIndex: number; row: number; level: string; note: string | null };

const LAYOUT = {
  labor: { firstRow: 8, lastRow: 14, dateCol: 13, valueCol: 8, noteCol: 3, totalRow: 15 },
  equipment: { firstRow: 8, lastRow: 12, dateCol: 13, valueCol: 7, noteCol: 1, totalRow: 13 },
} as const;

function text(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (typeof v === 'object' && 'richText' in (v as object)) return (v as { richText: { text: string }[] }).richText.map((x) => x.text).join('');
  return String(v);
}
function minutesOf(v: ExcelJS.CellValue): number {
  const m = text(v).replace(/‏/g, '').match(/(\d+):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}
function fmtMinutes(m: number): string { return '‏' + Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); }

// صفوف الأيام اللي فيها بيانات فعلًا في ورقة (تاريخ + قيمة) — الأساس لحساب "كل السطور اتشطبت"
export function dataRowsOf(ws: ExcelJS.Worksheet, kind: Kind): number[] {
  const L = LAYOUT[kind];
  const out: number[] = [];
  for (let r = L.firstRow; r <= L.lastRow; r++) {
    if (text(ws.getCell(r, L.dateCol).value) && text(ws.getCell(r, L.valueCol).value)) out.push(r);
  }
  return out;
}

// عدد سطور البيانات في المصنّف كله (لو الملف مش xlsx حقيقي بيرجع null — ما نقدرش نحكم)
export async function countDataRows(buffer: Buffer, kind: Kind): Promise<number | null> {
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    return wb.worksheets.reduce((a, ws) => a + dataRowsOf(ws, kind).length, 0);
  } catch {
    return null;
  }
}

// نمطان (قرار صاحب المشروع 7 سبتمبر 2026):
//   'strike' — جوّه التطبيق أثناء المراجعة: السطر أحمر بخط في النص + السبب في خانة الملاحظات (المعتمدين اللي بعده يشوفوا إيه اللي اتشال وليه)
//   'clear'  — النسخة اللي بتتختم وتروح جوجل شيت/الـ DC: السطر يبقى **يوم فاضي** (التاريخ واليوم بس، وتوقيع المهندس على السطر بيتشال)،
//              من غير أي أثر أحمر — السبب بيوصل الـ DC في خانة "سلسلة الاعتماد" جنب الصف في الشيت
export type RejectMode = 'strike' | 'clear';

// شيل صور (توقيع المهندس) المرساة على صف معيّن — ExcelJS مافيهاش removeImage عام، فبنفلتر _media
function removeImagesOnRow(ws: ExcelJS.Worksheet, row: number): void {
  const media = (ws as unknown as { _media?: Array<{ type: string; range?: { tl?: { nativeRow?: number } } }> })._media;
  if (!Array.isArray(media)) return;
  const keep = media.filter((m) => !(m.type === 'image' && m.range?.tl && Math.floor(Number(m.range.tl.nativeRow)) === row - 1));
  (ws as unknown as { _media: unknown[] })._media = keep;
}

// تطبيق الشطب على الملف: بيرجع نسخة معدّلة (الأصل في التخزين ما بيتغيرش). فشل القراءة → نفس الملف.
export async function applyRowRejections(buffer: Buffer, rejections: RowRejection[], kind: Kind, mode: RejectMode = 'strike'): Promise<Buffer> {
  if (!rejections.length) return buffer;
  const L = LAYOUT[kind];
  let wb: ExcelJS.Workbook;
  try {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    return buffer;
  }
  const touched = new Set<number>();
  for (const rj of rejections) {
    const ws = wb.worksheets[rj.sheetIndex];
    if (!ws || rj.row < L.firstRow || rj.row > L.lastRow) continue;
    touched.add(rj.sheetIndex);
    if (mode === 'clear') {
      // يوم فاضي: كل القيم تتمسح ماعدا التاريخ (13) واليوم (12) — والتنسيق يفضل زي أي يوم بلا شغل، والتوقيع يتشال
      for (let c = 1; c <= 11; c++) ws.getCell(rj.row, c).value = null;
      removeImagesOnRow(ws, rj.row);
      continue;
    }
    for (let c = 1; c <= 13; c++) {
      const cell = ws.getCell(rj.row, c);
      // ⚠ ExcelJS بيشارك كائن الـ style بين الخلايا المتشابهة بعد التحميل — تعديل cell.font مباشرة كان بيلوّن الشيت كله أحمر.
      // لازم ننسخ الـ style للخلية دي بس قبل التعديل.
      cell.style = {
        ...cell.style,
        font: { ...(cell.style.font || {}), strike: true, color: { argb: 'FFB71C1C' } },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE8E8' } },
      };
    }
    ws.getCell(rj.row, L.valueCol).value = kind === 'labor' ? 0 : fmtMinutes(0);
    const noteCell = ws.getCell(rj.row, L.noteCol);
    const prev = text(noteCell.value);
    noteCell.value = (prev ? prev + '\n' : '') + '❌ مرفوض (' + rj.level + ')' + (rj.note ? ': ' + rj.note : '');
    noteCell.style = { ...noteCell.style, alignment: { ...(noteCell.style.alignment || {}), wrapText: true } };
    ws.getRow(rj.row).height = Math.max(Number(ws.getRow(rj.row).height) || 30, 44);
  }
  // نلقط الورقات اللي اتلمست هنا (لسه الـ index صح) — هنحتاجها بعد الحذف المحتمل تحت
  const touchedSheets = [...touched].map((idx) => wb.worksheets[idx]).filter((ws): ws is ExcelJS.Worksheet => !!ws);

  // 'clear': ورقة اتفضّت تمامًا بالشطب (كل صفوفها بقت أيام فاضية) تتشال من المصنّف كله —
  // من غير كده الـ DC هيستلم ورقة فاضية لسه شايلة بلوكات التوقيع. لو الشيل هيسيب المصنّف من غير ورقات خالص، نوقف (ضمان دفاعي).
  if (mode === 'clear') {
    for (const ws of touchedSheets) {
      if (wb.worksheets.length <= 1) break;
      if (dataRowsOf(ws, kind).length === 0) wb.removeWorksheet(ws.id);
    }
  }

  // إعادة حساب إجمالي الورقة (بس للورقات اللي لسه موجودة بعد الحذف المحتمل)
  for (const ws of touchedSheets) {
    if (!wb.worksheets.includes(ws)) continue;
    if (kind === 'labor') {
      let sum = 0;
      for (let r = L.firstRow; r <= L.lastRow; r++) sum += Number(ws.getCell(r, L.valueCol).value) || 0;
      ws.getCell(L.totalRow, L.valueCol).value = sum;
    } else {
      let sum = 0;
      for (let r = L.firstRow; r <= L.lastRow; r++) sum += minutesOf(ws.getCell(r, L.valueCol).value);
      ws.getCell(L.totalRow, L.valueCol).value = fmtMinutes(sum);
    }
  }
  // المعدات: إجمالي الشهر (كل ورقات نفس المعدة — الاسم "n- المعدة") بيتعاد حسابه بعد الشطب
  if (kind === 'equipment' && touched.size) {
    const groups = new Map<string, ExcelJS.Worksheet[]>();
    wb.worksheets.forEach((ws) => { const k = ws.name.replace(/^\d+-\s*/, ''); (groups.get(k) ?? groups.set(k, []).get(k)!).push(ws); });
    for (const list of groups.values()) {
      let mins = 0, days = 0;
      for (const ws of list) for (let r = L.firstRow; r <= L.lastRow; r++) { const m = minutesOf(ws.getCell(r, L.valueCol).value); if (m > 0) { mins += m; days++; } }
      for (const ws of list) ws.getCell(L.totalRow, 6).value = `إجمالي الشهر: ${fmtMinutes(mins).replace(/‏/g, '')} ساعة (${days} يوم تشغيل)`;
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
