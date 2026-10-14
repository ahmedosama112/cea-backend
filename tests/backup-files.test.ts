import { afterEach, describe, expect, it, vi } from 'vitest';
import { storage } from '../src/services/storage';
import { backupFiles, decodeBackupFile } from '../src/services/backupFiles';
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
describe('Backup file integrity', () => {
  afterEach(() => vi.restoreAllMocks());
  it('backs up actual bytes and verifies their checksum during recovery', async () => {
    vi.spyOn(storage, 'read').mockResolvedValue(png);
    const objects = new Map<string, string>();
    const manifest = await backupFiles([{ filePath: 'test.png' }], async (name, json) => { objects.set(name, json); });
    expect(decodeBackupFile(objects.get(manifest[0].objectName)!, manifest[0])).toEqual(png);
    expect(() => decodeBackupFile(JSON.stringify({ base64: 'YmFk' }), manifest[0])).toThrow('integrity');
    vi.spyOn(storage, 'read').mockRejectedValueOnce(new Error('missing'));
    await expect(backupFiles([{ filePath: 'missing' }], async () => {})).rejects.toThrow('missing');
  });
});
