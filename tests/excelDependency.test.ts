import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

describe('ExcelJS UUID override compatibility', () => {
  it('writes and reads extended conditional formatting using UUID v4', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('UUID compatibility');
    sheet.addRows([[1], [2], [3]]);
    sheet.addConditionalFormatting({
      ref: 'A1:A3',
      rules: [{ type: 'iconSet', iconSet: '3Stars', priority: 1, cfvo: [{ type: 'percent', value: 0 }, { type: 'percent', value: 33 }, { type: 'percent', value: 67 }] }],
    });
    const buffer = await workbook.xlsx.writeBuffer();
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(xml).toMatch(/\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}/);
    const loaded = new ExcelJS.Workbook();
    await loaded.xlsx.load(buffer);
    expect(loaded.getWorksheet('UUID compatibility')!.getCell('A2').value).toBe(2);
    expect(loaded.getWorksheet('UUID compatibility')!.conditionalFormattings).toHaveLength(1);
  });
});
