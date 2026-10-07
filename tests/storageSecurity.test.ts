import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { storage } from '../src/services/storage';

describe('Local storage containment', () => {
  const originalRoot = env.uploadDir;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cea-storage-security-'));
  const root = path.join(fixture, 'uploads');
  const sibling = path.join(fixture, 'uploads-evil');
  const outside = path.join(fixture, 'outside');
  beforeAll(() => {
    env.uploadDir = root;
    for (const dir of [root, sibling, outside]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'canary.txt'), 'storage-security-canary');
    }
  });
  afterAll(() => { env.uploadDir = originalRoot; fs.rmSync(fixture, { recursive: true, force: true }); });

  it.each([
    ['prefix sibling', '../uploads-evil/canary.txt'],
    ['parent traversal', '../outside/canary.txt'],
    ['absolute outside', path.join(outside, 'canary.txt')],
    ['upload root', ''],
    ['parent directory', '..'],
  ])('rejects %s for both reads and deletion', async (_label, storedPath) => {
    await expect(storage.read(storedPath)).rejects.toThrow('Invalid storage path');
    await expect(storage.remove(storedPath)).rejects.toThrow('Invalid storage path');
    expect(fs.existsSync(path.join(sibling, 'canary.txt'))).toBe(true);
    expect(fs.existsSync(path.join(outside, 'canary.txt'))).toBe(true);
  });

  it('round-trips and deletes generated storage paths', async () => {
    const data = Buffer.from('local-storage-roundtrip');
    const saved = await storage.save(data, 'test.png');
    expect(await storage.read(saved.storedPath)).toEqual(data);
    await storage.remove(saved.storedPath);
    await expect(storage.read(saved.storedPath)).rejects.toThrow();
    await expect(storage.remove(saved.storedPath)).resolves.toBeUndefined();
  });

  it('allows contained filenames beginning with two dots', async () => {
    fs.writeFileSync(path.join(root, '..contained.txt'), 'contained');
    expect((await storage.read('..contained.txt')).toString()).toBe('contained');
    await storage.remove('..contained.txt');
  });
});
