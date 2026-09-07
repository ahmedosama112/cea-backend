import ExcelJS from 'exceljs';

// ═══════════ ختم توقيعات المعتمدين على ملف الكشف ═══════════
// قبل سبتمبر 2026 كانت التوقيعات بتتحط في جوجل شيت: الـ Apps Script بيلزق صور ثابتة من Drive
// لما الـ DC يضغط "اعتماد". الزرار ده مكنش خطوة موافقة أصلًا — كان حيلة عشان التوقيعات والـ PDF
// ينزلوا. دلوقتي الاعتماد كله جوه التطبيق، فبنختم توقيع **الشخص اللي اعتمد فعلًا** على الملف
// قبل ما يتبعت، والملف بيوصل جوجل موقّعًا بالكامل.
//
// تخطيط صف التوقيعات في الكشف (buildApprovedSheet في app.js):
//   الصف 16 = صف التوقيعات (ارتفاعه 55)، الصف 17 = العناوين
//   البلوكات التلاتة: A16 (أعمدة 1-5) · G16 (7-9) · J16 (10-13)
//   الترتيب الحالي: A = مدير المشروع · G = مدير التنفيذ · J = مدير الفريق (كان "توقيع العامل")
// ⚠ الملفات القديمة (قبل تبديل الأماكن) عناوينها بترتيب تاني — فبنقرأ نص العنوان في الصف 17
//   لكل بلوك ونحدد منه المستوى، والترتيب الافتراضي تحت بيستخدم بس لو مفيش عناوين مفهومة.
// الصورة بتتحجّم **بنسبتها الأصلية** جوّه صندوق أصغر من البلوك وبتتوسّط فيه — مش بتتشدّ على البلوك.
// المرساة بنقطتين (tl/br) — مرساة بنقطة واحدة بتكتب أبعادًا صفرية فتختفي الصورة في Excel الصارم
// (جوجل شيت متسامح) — نفس الدرس المكتوب في app.js عند توقيع المهندس.

export const SIGNATURE_ROW = 16; // 1-based
export const CAPTION_ROW = 17;   // عناوين البلوكات

type Block = { from: number; to: number };
// البلوكات التلاتة (أعمدة صفرية، النهاية غير شاملة: A..E = 0..5)
const BLOCKS: Block[] = [{ from: 0, to: 5 }, { from: 6, to: 9 }, { from: 9, to: 13 }];

// الترتيب الافتراضي (الملفات الجديدة) — يُستخدم لو العناوين مش مقروءة
const DEFAULT_BLOCK: Record<string, Block> = {
  'project manager': BLOCKS[0],
  'construction manager': BLOCKS[1],
  'team leader': BLOCKS[2],
};

// نص العنوان → المستوى ("توقيع العامل" = البلوك القديم اللي بقى لمدير الفريق)
// كشف المعدات (سبتمبر 2026): عناوينه "المشرف المسئول" (= توقيع المهندس نفسه، بيتحط في الواجهة) و"مهندس التنفيذ"
// (= construction manager). بلوك المشرف بيتسجل كـ 'engineer' عشان يتحسب ضمن الثلاثة ومايتحطش فوقه توقيع مدير الفريق
function levelFromCaption(text: string): string | null {
  const t = text.replace(/\s+/g, ' ');
  if (t.includes('مدير المشروع')) return 'project manager';
  if (t.includes('التنفيذ')) return 'construction manager';
  if (t.includes('الفريق') || t.includes('العامل')) return 'team leader';
  if (t.includes('المشرف') || t.includes('المهندس')) return 'engineer';
  return null;
}

function cellText(ws: ExcelJS.Worksheet, row: number, col1: number): string {
  const v = ws.getCell(row, col1).value as unknown;
  if (v == null) return '';
  if (typeof v === 'object' && v && 'richText' in (v as object)) return (v as { richText: { text: string }[] }).richText.map((x) => x.text).join('');
  return String(v);
}

// خريطة المستوى → البلوك لورقة معيّنة، من عناوين الصف 17 (أو الافتراضي)
export function blocksForSheet(ws: ExcelJS.Worksheet): Record<string, Block> {
  const found: Record<string, Block> = {};
  for (const b of BLOCKS) {
    // العنوان ممكن يكون في أي خلية من البلوك المدموج (ExcelJS بيرجّع قيمة الخلية الرئيسية للكل)
    let lv: string | null = null;
    for (let c = b.from; c < b.to && !lv; c++) lv = levelFromCaption(cellText(ws, CAPTION_ROW, c + 1));
    if (lv && !found[lv]) found[lv] = b;
  }
  return Object.keys(found).length === 3 ? found : { ...DEFAULT_BLOCK, ...found };
}

// أقصى حجم للتوقيع كنسبة من البلوك (أصغر شوية من الحجم القديم عشان يبقى مريح جوّه الخلية)
const MAX_W_RATIO = 0.5;
const MAX_H_RATIO = 0.58;

export type LevelSignature = { level: string; image: Buffer; ext: 'png' | 'jpeg' };

export function hasSignatureBox(level: string): boolean {
  return level in DEFAULT_BLOCK;
}

// أبعاد الصورة من الهيدر (PNG أو JPEG) — من غير مكتبة صور. null لو مش مفهومة → نفترض 3:1
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // SOF0..SOF15 ما عدا DHT/JPG/DAC — فيها الأبعاد
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

// عرض العمود بالبكسل (تقريب Excel المعتاد: 7px لكل حرف + 5 هامش)
function colPx(ws: ExcelJS.Worksheet, col0: number): number {
  const w = ws.getColumn(col0 + 1).width ?? 8.43;
  return Math.round(w * 7 + 5);
}
// وحدات EMU الحقيقية في ملف xlsx: البكسل = 9525، والنقطة = 12700.
// ⚠ مرساة exceljs الكسرية (col: 1.4) بتتحوّل لـ EMU بمعادلة غلط (عرض العمود بالحروف × 10000)
// فالإزاحة جوّه العمود بتتلاشى والصورة بتلزق بحدود الأعمدة وتتشوّه — عشان كده بنكتب المرساة
// بصيغتها الأصلية (nativeCol/nativeColOff…) بالـ EMU الصح مباشرة.
const EMU_PX = 9525, EMU_PT = 12700;

export type NativeAnchor = { nativeCol: number; nativeColOff: number; nativeRow: number; nativeRowOff: number };

// بيرجع مرساة الصورة جوّه البلوك: محجّمة بنسبتها ومتوسّطة أفقيًا ورأسيًا
export function fitInBlock(
  ws: ExcelJS.Worksheet,
  block: { from: number; to: number },
  img: { width: number; height: number },
): { tl: NativeAnchor; br: NativeAnchor } {
  const widths: number[] = [];
  for (let c = block.from; c < block.to; c++) widths.push(colPx(ws, c));
  const blockW = widths.reduce((a, b) => a + b, 0);
  const rowPt = ws.getRow(SIGNATURE_ROW).height ?? 15;
  const blockH = rowPt * (96 / 72); // px
  const scale = Math.min((blockW * MAX_W_RATIO) / img.width, (blockH * MAX_H_RATIO) / img.height);
  const w = img.width * scale, h = img.height * scale;
  const left = (blockW - w) / 2, top = (blockH - h) / 2;
  // بكسل من بداية البلوك → (عمود، إزاحة EMU جوّاه)
  const toCol = (px: number) => {
    let acc = 0;
    for (let i = 0; i < widths.length; i++) {
      if (px < acc + widths[i] || i === widths.length - 1) return { nativeCol: block.from + i, nativeColOff: Math.round((px - acc) * EMU_PX) };
      acc += widths[i];
    }
    return { nativeCol: block.to - 1, nativeColOff: 0 };
  };
  const r0 = SIGNATURE_ROW - 1;
  const toRowOff = (px: number) => Math.round(px * 0.75 * EMU_PT); // px → pt → EMU
  return {
    tl: { ...toCol(left), nativeRow: r0, nativeRowOff: toRowOff(top) },
    br: { ...toCol(left + w), nativeRow: r0, nativeRowOff: toRowOff(top + h) },
  };
}

// بيرجع نسخة جديدة من الملف بعد لصق التوقيعات على كل أوراق المصنّف (ورقة لكل مقاول).
// أي فشل بيترمي — المستدعي بيقرر يبعت الأصل ولا يوقف.
// (فحص أمني 2026-09-06 — N11) الملف جاي من جهاز المهندس: حدود على حجمه المفكوك قبل الختم —
// مصنّف ضخم أو مشوّه (zip-bomb) مايستهلكش السيرفر. الملف الحقيقي: 1–20 ورقة × ~20 صف.
export const MAX_SHEETS = 60;
export const MAX_ROWS_PER_SHEET = 5000;
export class StampLimitError extends Error {}

export async function stampSignatures(fileBuffer: Buffer, signatures: LevelSignature[]): Promise<Buffer> {
  const usable = signatures.filter((s) => hasSignatureBox(s.level) && s.image?.length);
  if (!usable.length) return fileBuffer;

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fileBuffer as unknown as ArrayBuffer);
  if (wb.worksheets.length > MAX_SHEETS) throw new StampLimitError(`المصنّف فيه ${wb.worksheets.length} ورقة — أكبر من الحد ${MAX_SHEETS}`);
  const big = wb.worksheets.find((ws) => ws.rowCount > MAX_ROWS_PER_SHEET);
  if (big) throw new StampLimitError(`ورقة "${big.name}" فيها ${big.rowCount} صف — أكبر من الحد ${MAX_ROWS_PER_SHEET}`);

  // الصورة بتتسجل مرة واحدة في المصنّف وبتتلزق على كل ورقة بنفس الـ id
  const imageIds = usable.map((s) => ({
    level: s.level,
    size: imageSize(s.image) ?? { width: 3, height: 1 },
    id: wb.addImage({ buffer: s.image as unknown as ExcelJS.Buffer, extension: s.ext }),
  }));

  wb.eachSheet((ws) => {
    // ورقة مالهاش صف توقيعات (ملف قديم أو مبني بشكل مختلف) بتتساب زي ما هي
    if (ws.rowCount < SIGNATURE_ROW) return;
    const blocks = blocksForSheet(ws);
    for (const { level, id, size } of imageIds) {
      // مستوى مالوش بلوك في الورقة دي (مثلًا مدير الفريق في كشف المعدات) بيتخطى بدل ما الختم يتكسر
      const block = blocks[level];
      if (!block) continue;
      ws.addImage(id, { ...fitInBlock(ws, block, size), editAs: 'oneCell' } as unknown as ExcelJS.ImageRange);
    }
  });

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
