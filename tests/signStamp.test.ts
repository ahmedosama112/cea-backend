import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { stampSignatures, hasSignatureBox, imageSize, fitInBlock, SIGNATURE_ROW } from '../src/services/signStamp';

// ختم توقيعات المعتمدين على ملف الكشف قبل ما يتبعت لجوجل
// (الملف الحقيقي بيتبني في الواجهة بنفس exceljs، فالقراءة/الكتابة هنا نفس المسار)

// PNG صغير صالح (1x1) — المهم إن exceljs يقبله ويكتبه في المصنّف
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function makeSheet(rows = 20, sheets = 2): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (let s = 0; s < sheets; s++) {
    const ws = wb.addWorksheet('مقاول ' + (s + 1));
    // نفس عروض أعمدة الكشف الحقيقي (buildApprovedSheet) وارتفاع صف التوقيعات
    ws.columns = [12, 10, 12, 6, 6, 6, 6, 12, 8, 8, 8, 8, 8].map((width) => ({ width }));
    for (let r = 1; r <= rows; r++) ws.getCell(r, 1).value = 'r' + r;
    if (rows >= SIGNATURE_ROW) ws.getRow(SIGNATURE_ROW).height = 55;
    if (rows >= SIGNATURE_ROW) {
      ws.mergeCells(SIGNATURE_ROW, 1, SIGNATURE_ROW, 5);
      ws.mergeCells(SIGNATURE_ROW, 7, SIGNATURE_ROW, 9);
      ws.mergeCells(SIGNATURE_ROW, 10, SIGNATURE_ROW, 13);
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function load(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

describe('ختم التوقيعات على الكشف', () => {
  it('بيلزق توقيع كل مستوى على كل أوراق المصنّف', async () => {
    const src = await makeSheet();
    const out = await stampSignatures(src, [
      { level: 'team leader', image: PNG_1PX, ext: 'png' },
      { level: 'construction manager', image: PNG_1PX, ext: 'png' },
      { level: 'project manager', image: PNG_1PX, ext: 'png' },
    ]);
    const wb = await load(out);
    expect(wb.worksheets.length).toBe(2);
    for (const ws of wb.worksheets) {
      const imgs = ws.getImages();
      expect(imgs.length).toBe(3);
      // كلها في صف التوقيعات (المرساة صفرية: الصف 16 → 15)
      for (const im of imgs) expect(Math.floor(im.range.tl.nativeRow)).toBe(SIGNATURE_ROW - 1);
      // ومرساة بنقطتين (br موجودة) — من غيرها الصورة بتختفي في Excel الصارم
      for (const im of imgs) expect(im.range.br).toBeTruthy();
    }
  });

  it('التوقيع بيتحجّم بنسبته الأصلية جوّه البلوك ومتوسّط — مش بيتشدّ ولا يطلع برّه', async () => {
    expect(imageSize(PNG_1PX)).toEqual({ width: 1, height: 1 });
    expect(imageSize(Buffer.from('not an image'))).toBeNull();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('x');
    ws.columns = [12, 10, 12, 6, 6, 6, 6, 12, 8, 8, 8, 8, 8].map((width) => ({ width }));
    ws.getRow(SIGNATURE_ROW).height = 55;
    const block = { from: 0, to: 5 }; // A16
    const EMU_PX = 9525;
    // بكسل مطلقة من بداية البلوك (عشان نقارن العرض/الارتفاع بغض النظر عن العمود)
    const widths = [12, 10, 12, 6, 6].map((w) => Math.round(w * 7 + 5));
    const absPx = (a: { nativeCol: number; nativeColOff: number }) => widths.slice(0, a.nativeCol).reduce((x, y) => x + y, 0) + a.nativeColOff / EMU_PX;
    const blockW = widths.reduce((x, y) => x + y, 0);
    // صورة عريضة 3:1 — بتاخد العرض المسموح ونسبتها محفوظة
    const wide = fitInBlock(ws, block, { width: 300, height: 100 });
    const wW = absPx(wide.br) - absPx(wide.tl);
    const wH = (wide.br.nativeRowOff - wide.tl.nativeRowOff) / 12700 / 0.75;
    expect(wW / wH).toBeCloseTo(3, 1);
    expect(wW).toBeLessThan(blockW * 0.51);
    expect(absPx(wide.tl)).toBeGreaterThan(0);
    expect(absPx(wide.br)).toBeLessThan(blockW);
    expect(wide.tl.nativeRow).toBe(SIGNATURE_ROW - 1);
    expect(wide.br.nativeRowOff).toBeLessThan(55 * 12700);
    // متوسّطة أفقيًا ورأسيًا
    expect(absPx(wide.tl)).toBeCloseTo(blockW - absPx(wide.br), 0);
    expect(wide.tl.nativeRowOff).toBeCloseTo(55 * 12700 - wide.br.nativeRowOff, -3);
    // صورة مربعة — الارتفاع هو اللي بيحكم، والنسبة 1:1 محفوظة
    const square = fitInBlock(ws, block, { width: 100, height: 100 });
    const sW = absPx(square.br) - absPx(square.tl);
    const sH = (square.br.nativeRowOff - square.tl.nativeRowOff) / 12700 / 0.75;
    expect(sW / sH).toBeCloseTo(1, 1);
    expect(sW).toBeLessThan(wW);
  });

  it('بيحافظ على محتوى الملف الأصلي (القراءة/الكتابة مش بتضيّع الخلايا ولا الدمج)', async () => {
    const src = await makeSheet();
    const out = await stampSignatures(src, [{ level: 'team leader', image: PNG_1PX, ext: 'png' }]);
    const wb = await load(out);
    const ws = wb.worksheets[0];
    expect(ws.getCell(1, 1).value).toBe('r1');
    expect(ws.getCell(20, 1).value).toBe('r20');
    expect(ws.getImages().length).toBe(1);
  });

  it('بلا توقيعات صالحة بيرجّع نفس الملف من غير ما يفتحه', async () => {
    const src = await makeSheet();
    const same = await stampSignatures(src, []);
    expect(same).toBe(src);
    // مستوى مالوش بلوك توقيع في الكشف (junior مثلًا) بيتتجاهل
    expect(hasSignatureBox('junior')).toBe(false);
    const same2 = await stampSignatures(src, [{ level: 'junior', image: PNG_1PX, ext: 'png' }]);
    expect(same2).toBe(src);
  });

  it('ورقة أقصر من صف التوقيعات بتتساب زي ما هي (ملف بشكل مختلف)', async () => {
    const src = await makeSheet(5, 1);
    const out = await stampSignatures(src, [{ level: 'team leader', image: PNG_1PX, ext: 'png' }]);
    const wb = await load(out);
    expect(wb.worksheets[0].getImages().length).toBe(0);
  });
});
