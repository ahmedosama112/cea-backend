import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { validateWorkbook } from '../src/services/workbookSafety';

describe('Workbook decompression limits', () => {
  it('accepts normal Excel files', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('test').getCell('A1').value = 'hello';
    await expect(validateWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()))).resolves.toBeUndefined();
  });
  it('rejects oversized inflated entries before ExcelJS loads them', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('test').getCell('A1').value = 'hello';
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const central = bytes.indexOf(Buffer.from('504b0102', 'hex'));
    expect(central).toBeGreaterThan(0);
    bytes.writeUInt32LE(65 * 1024 * 1024, central + 24);
    await expect(validateWorkbook(bytes)).rejects.toThrow('64 MiB');
  });
  // (أمان — فحص نوفمبر 2026) عدد المداخل في EOCD متقلّل بواحد: unzipper مابيشوفش المدخل الأخير، بس JSZip
  // (اللي ExcelJS بيستخدمه) بيقراه ويفكّه كله — الفحص لازم يرفضه قبل ما ExcelJS يلمسه
  async function withHiddenEntry(hiddenMiB: number): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('test').getCell('A1').value = 'hello';
    const zip = await JSZip.loadAsync(Buffer.from(await workbook.xlsx.writeBuffer()));
    zip.file('xl/zz-hidden.xml', Buffer.alloc(hiddenMiB * 1024 * 1024, 0x41));
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
    const eocd = bytes.lastIndexOf(Buffer.from('504b0506', 'hex'));
    expect(eocd).toBeGreaterThan(0);
    bytes.writeUInt16LE(bytes.readUInt16LE(eocd + 8) - 1, eocd + 8);
    bytes.writeUInt16LE(bytes.readUInt16LE(eocd + 10) - 1, eocd + 10);
    return bytes;
  }
  it('rejects a hidden central-directory entry that only JSZip/ExcelJS would inflate', async () => {
    const bytes = await withHiddenEntry(70);
    expect(bytes.length).toBeLessThan(1024 * 1024);
    await expect(validateWorkbook(bytes)).rejects.toThrow();
  });
  it('rejects a mismatched entry list even when the hidden entry is small', async () => {
    await expect(validateWorkbook(await withHiddenEntry(1))).rejects.toThrow('بنية ملف Excel غير صالحة');
  });
});
