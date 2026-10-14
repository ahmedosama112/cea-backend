import { Open } from 'unzipper';
import { AppError } from '../utils/AppError';

// Excel's ZIP compression can hide far more data than the upload-size limit.
// Check actual inflated bytes with streams before ExcelJS allocates the workbook.
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 2048;
export async function validateWorkbook(buffer: Buffer): Promise<void> {
  const zip = await Open.buffer(buffer);
  if (zip.files.length > MAX_ENTRIES) throw AppError.validation('ملف Excel يحتوي عناصر أكثر من المسموح');
  let total = 0;
  for (const file of zip.files) {
    if (file.uncompressedSize > MAX_EXPANDED_BYTES - total) throw AppError.validation('حجم Excel بعد فك الضغط أكبر من المسموح (64 MiB)');
    let entryBytes = 0;
    const stream = file.stream();
    try {
      for await (const chunk of stream) {
        entryBytes += chunk.length;
        total += chunk.length;
        if (total > MAX_EXPANDED_BYTES) throw AppError.validation('حجم Excel بعد فك الضغط أكبر من المسموح (64 MiB)');
      }
    } finally { stream.destroy(); }
    if (entryBytes !== file.uncompressedSize) throw AppError.validation('بيانات حجم ملف Excel غير صحيحة');
  }
}
