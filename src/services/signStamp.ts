import ExcelJS from 'exceljs';

// ═══════════ ختم توقيعات المعتمدين على ملف الكشف ═══════════
// قبل سبتمبر 2026 كانت التوقيعات بتتحط في جوجل شيت: الـ Apps Script بيلزق صور ثابتة من Drive
// لما الـ DC يضغط "اعتماد". الزرار ده مكنش خطوة موافقة أصلًا — كان حيلة عشان التوقيعات والـ PDF
// ينزلوا. دلوقتي الاعتماد كله جوه التطبيق، فبنختم توقيع **الشخص اللي اعتمد فعلًا** على الملف
// قبل ما يتبعت، والملف بيوصل جوجل موقّعًا بالكامل.
//
// تخطيط صف التوقيعات في الكشف (buildApprovedSheet في app.js — ثابت لكل الشيتات):
//   الصف 16 = صف التوقيعات (ارتفاعه 55)، الصف 17 = العناوين
//   A16 (أعمدة 1-5) توقيع مدير التنفيذ · G16 (7-9) توقيع مدير المشروع · J16 (10-13) توقيع رئيس الفريق
// الأعمدة في exceljs هنا صفرية والمرساة بنقطتين (tl/br) — مرساة بنقطة واحدة بتكتب أبعادًا صفرية
// فتختفي الصورة في Excel الصارم (جوجل شيت متسامح) — نفس الدرس المكتوب في app.js عند توقيع المهندس.

export const SIGNATURE_ROW = 16; // 1-based

// المستوى → مكان توقيعه في الصف (الأعمدة صفرية: العمود A = 0)
const SIGNATURE_BOX: Record<string, { from: number; to: number }> = {
  'construction manager': { from: 1.0, to: 4.0 },  // بلوك A16 (0..5)
  'project manager': { from: 6.4, to: 8.6 },       // بلوك G16 (6..9)
  'team leader': { from: 9.6, to: 12.4 },          // بلوك J16 (9..13) — كان "توقيع العامل"
};

export type LevelSignature = { level: string; image: Buffer; ext: 'png' | 'jpeg' };

export function hasSignatureBox(level: string): boolean {
  return level in SIGNATURE_BOX;
}

// بيرجع نسخة جديدة من الملف بعد لصق التوقيعات على كل أوراق المصنّف (ورقة لكل مقاول).
// أي فشل بيترمي — المستدعي بيقرر يبعت الأصل ولا يوقف.
export async function stampSignatures(fileBuffer: Buffer, signatures: LevelSignature[]): Promise<Buffer> {
  const usable = signatures.filter((s) => hasSignatureBox(s.level) && s.image?.length);
  if (!usable.length) return fileBuffer;

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fileBuffer as unknown as ArrayBuffer);

  // الصورة بتتسجل مرة واحدة في المصنّف وبتتلزق على كل ورقة بنفس الـ id
  const imageIds = usable.map((s) => ({
    level: s.level,
    id: wb.addImage({ buffer: s.image as unknown as ExcelJS.Buffer, extension: s.ext }),
  }));

  wb.eachSheet((ws) => {
    // ورقة مالهاش صف توقيعات (ملف قديم أو مبني بشكل مختلف) بتتساب زي ما هي
    if (ws.rowCount < SIGNATURE_ROW) return;
    for (const { level, id } of imageIds) {
      const box = SIGNATURE_BOX[level];
      ws.addImage(id, {
        tl: { col: box.from, row: SIGNATURE_ROW - 1 + 0.15 },
        br: { col: box.to, row: SIGNATURE_ROW - 1 + 0.85 },
        editAs: 'oneCell',
      } as unknown as ExcelJS.ImageRange);
    }
  });

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
