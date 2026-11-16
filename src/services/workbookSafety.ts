import JSZip from 'jszip';
import { Open } from 'unzipper';
import { AppError } from '../utils/AppError';

// Excel's ZIP compression can hide far more data than the upload-size limit.
// Check actual inflated bytes with streams before ExcelJS allocates the workbook.
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 2048;
const tooBig = () => AppError.validation('حجم Excel بعد فك الضغط أكبر من المسموح (64 MiB)');
const badStructure = () => AppError.validation('بنية ملف Excel غير صالحة');

export async function validateWorkbook(buffer: Buffer): Promise<void> {
  const zip = await Open.buffer(buffer);
  if (zip.files.length > MAX_ENTRIES) throw AppError.validation('ملف Excel يحتوي عناصر أكثر من المسموح');
  let total = 0;
  for (const file of zip.files) {
    if (file.uncompressedSize > MAX_EXPANDED_BYTES - total) throw tooBig();
    let entryBytes = 0;
    const stream = file.stream();
    try {
      for await (const chunk of stream) {
        entryBytes += chunk.length;
        total += chunk.length;
        if (total > MAX_EXPANDED_BYTES) throw tooBig();
      }
    } finally { stream.destroy(); }
    if (entryBytes !== file.uncompressedSize) throw AppError.validation('بيانات حجم ملف Excel غير صحيحة');
  }
  await validateAsExcelJsSeesIt(buffer, zip.files.map((f) => f.path));
}

// (أمان — فحص نوفمبر 2026) ExcelJS بيقرا الملف بـ JSZip مش unzipper. unzipper بيصدّق عدد المداخل المكتوب في
// نهاية الأرشيف (EOCD)، وJSZip بيقرا كل رؤوس الـ central directory الموجودة فعلًا — فملف عدده متقلّل كان بيخبّي
// مدخل ضخم الفحص اللي فوق مابيشوفوش وExcelJS بيفكّه كله في الذاكرة. هنا بنفحص نفس المداخل اللي ExcelJS هيفكّها:
// لازم تطابق قايمة unzipper بالظبط (من غير أسماء مكررة)، وكل بايت بيتفك بيتعد على نفس الحد.
async function validateAsExcelJsSeesIt(buffer: Buffer, unzipperNames: string[]): Promise<void> {
  let jz: JSZip;
  try { jz = await JSZip.loadAsync(buffer); } catch { throw badStructure(); }
  const entries = Object.values(jz.files);
  const names = new Set(unzipperNames);
  if (names.size !== unzipperNames.length || entries.length !== names.size) throw badStructure();
  if (entries.some((e) => !names.has(e.name))) throw badStructure();
  let total = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    // JSZip's node stream is readable-stream v2 (no async iterator) — count bytes from 'data' events
    const stream = entry.nodeStream('nodebuffer') as NodeJS.ReadableStream & { destroy?: () => void };
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: unknown) => {
        if (settled) return;
        settled = true;
        if (err) { stream.pause(); stream.destroy?.(); reject(err instanceof AppError ? err : badStructure()); } else resolve();
      };
      stream.on('data', (chunk: Buffer) => { total += chunk.length; if (total > MAX_EXPANDED_BYTES) finish(tooBig()); });
      stream.on('error', (e) => finish(e ?? badStructure()));
      stream.on('end', () => finish());
    });
  }
}
