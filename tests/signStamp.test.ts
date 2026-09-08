import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { stampSignatures, hasSignatureBox, imageSize, fitInBlock, blocksForSheet, SIGNATURE_ROW, CAPTION_ROW, MAX_ROWS_PER_SHEET, StampLimitError } from '../src/services/signStamp';

// ختم توقيعات المعتمدين على ملف الكشف قبل ما يتبعت لجوجل
// (الملف الحقيقي بيتبني في الواجهة بنفس exceljs، فالقراءة/الكتابة هنا نفس المسار)

// PNG صغير صالح (1x1) — المهم إن exceljs يقبله ويكتبه في المصنّف
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// captions: عناوين البلوكات التلاتة بالترتيب A / G / J (الافتراضي = التخطيط الجديد)
const NEW_CAPTIONS = ['توقيع مدير المشروع', 'توقيع مدير التنفيذ', 'توقيع مدير الفريق'];
const OLD_CAPTIONS = ['توقيع مدير التنفيذ', 'توقيع مدير المشروع', 'توقيع العامل'];
async function makeSheet(rows = 20, sheets = 2, captions = NEW_CAPTIONS): Promise<Buffer> {
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
      ws.mergeCells(CAPTION_ROW, 1, CAPTION_ROW, 5); ws.getCell(CAPTION_ROW, 1).value = captions[0];
      ws.mergeCells(CAPTION_ROW, 7, CAPTION_ROW, 9); ws.getCell(CAPTION_ROW, 7).value = captions[1];
      ws.mergeCells(CAPTION_ROW, 10, CAPTION_ROW, 13); ws.getCell(CAPTION_ROW, 10).value = captions[2];
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

  it('مكان كل توقيع بيتحدد من عنوان البلوك — الملفات القديمة (ترتيب قديم) والجديدة بيتختموا صح', async () => {
    const col0 = (im: ExcelJS.Image) => im.range.tl.nativeCol;
    // تخطيط جديد: A = مدير المشروع · G = مدير التنفيذ · J = مدير الفريق
    const nw = await load(await stampSignatures(await makeSheet(20, 1), [
      { level: 'project manager', image: PNG_1PX, ext: 'png' },
      { level: 'construction manager', image: PNG_1PX, ext: 'png' },
      { level: 'team leader', image: PNG_1PX, ext: 'png' },
    ]));
    const nImgs = nw.worksheets[0].getImages().sort((a, b) => col0(a) - col0(b));
    expect(nImgs.length).toBe(3);
    expect(col0(nImgs[0])).toBeLessThan(5);           // مدير المشروع في A
    expect(col0(nImgs[1])).toBeGreaterThanOrEqual(6);
    expect(col0(nImgs[1])).toBeLessThan(9);           // مدير التنفيذ في G
    expect(col0(nImgs[2])).toBeGreaterThanOrEqual(9); // مدير الفريق في J

    // ملف قديم: A = مدير التنفيذ · G = مدير المشروع · J = "توقيع العامل"
    const oldWb = await load(await makeSheet(20, 1, OLD_CAPTIONS));
    const blocks = blocksForSheet(oldWb.worksheets[0]);
    expect(blocks['construction manager']).toEqual({ from: 0, to: 5 });
    expect(blocks['project manager']).toEqual({ from: 6, to: 9 });
    expect(blocks['team leader']).toEqual({ from: 9, to: 13 });
    // ورقة بلا عناوين → الترتيب الافتراضي (الجديد)
    const bare = new ExcelJS.Workbook().addWorksheet('x');
    expect(blocksForSheet(bare)['project manager']).toEqual({ from: 0, to: 5 });
  });

  it('كشف المعدات: "المشرف المسئول / مهندس التنفيذ / مدير المشروع" — بلوك المشرف للمهندس، ومدير الفريق بلا بلوك يتخطى', async () => {
    const EQUIP_CAPTIONS = ['توقيع مدير المشروع', 'توقيع مهندس التنفيذ', 'توقيع المشرف المسئول'];
    const src = await makeSheet(20, 1, EQUIP_CAPTIONS);
    const blocks = blocksForSheet((await load(src)).worksheets[0]);
    expect(blocks['project manager']).toEqual({ from: 0, to: 5 });
    expect(blocks['construction manager']).toEqual({ from: 6, to: 9 });
    expect(blocks['engineer']).toEqual({ from: 9, to: 13 });
    expect(blocks['team leader']).toBeUndefined(); // مفيش بلوك لمدير الفريق — ما يترجعش للافتراضي فوق بلوك المشرف
    const out = await load(await stampSignatures(src, [
      { level: 'project manager', image: PNG_1PX, ext: 'png' },
      { level: 'construction manager', image: PNG_1PX, ext: 'png' },
      { level: 'team leader', image: PNG_1PX, ext: 'png' },
    ]));
    const imgs = out.worksheets[0].getImages();
    expect(imgs.length).toBe(2); // مدير الفريق اتخطى بدل ما الختم يتكسر
    expect(imgs.every((im) => im.range.tl.nativeCol < 9)).toBe(true); // ولا صورة فوق بلوك المشرف (J)
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

  it('الشيت بيفضل نضيف: التوقيع بس — مفيش نص "معتمد بواسطة" جوّه الملف (بيتعرض في التطبيق برّه الشيت)', async () => {
    const buf = await makeSheet(20, 1);
    const at = new Date('2026-09-08T10:00:00Z');
    const out = await stampSignatures(buf, [
      { level: 'team leader', image: PNG_1PX, ext: 'png', by: 'أحمد', at },
      { level: 'construction manager', image: null, ext: 'png', by: 'مصطفى', at },
    ]);
    const ws = (await load(out)).worksheets[0];
    expect(String(ws.getCell(CAPTION_ROW, 10).value)).toBe('توقيع مدير الفريق');
    expect(String(ws.getCell(CAPTION_ROW, 7).value)).toBe('توقيع مدير التنفيذ');
    expect(ws.getImages().length).toBe(1); // مصطفى بلا توقيع → مفيش صورة ولا نص
  });

  it('(N11) مصنّف أكبر من الحد (ورقة فيها صفوف أكتر من المسموح) يترفض قبل الختم بدل ما يستهلك السيرفر', async () => {
    const huge = await makeSheet(MAX_ROWS_PER_SHEET + 1, 1);
    await expect(stampSignatures(huge, [{ level: 'project manager', image: PNG_1PX, ext: 'png' }])).rejects.toBeInstanceOf(StampLimitError);
  });

  it('ورقة أقصر من صف التوقيعات بتتساب زي ما هي (ملف بشكل مختلف)', async () => {
    const src = await makeSheet(5, 1);
    const out = await stampSignatures(src, [{ level: 'team leader', image: PNG_1PX, ext: 'png' }]);
    const wb = await load(out);
    expect(wb.worksheets[0].getImages().length).toBe(0);
  });
});
