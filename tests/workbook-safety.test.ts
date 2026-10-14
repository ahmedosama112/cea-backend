import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
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
});
