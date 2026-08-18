import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { env } from '../config/env';

// تجريد التخزين: اليوم Local Disk فقط — لاستخدام S3/R2 لاحقًا نفّذ نفس الواجهة StorageAdapter
// بدون أي تغيير في بقية الكود (الـ metadata كلها في جدول files في MySQL)
export interface StorageAdapter {
  save(buffer: Buffer, originalName: string): Promise<{ storedPath: string }>;
  read(storedPath: string): Promise<Buffer>;
  remove(storedPath: string): Promise<void>;
}

class LocalDiskStorage implements StorageAdapter {
  async save(buffer: Buffer, originalName: string): Promise<{ storedPath: string }> {
    const ext = path.extname(originalName).toLowerCase().slice(0, 10);
    // اسم عشوائي بالكامل — اسم الملف الأصلي يُحفظ في DB فقط، لا يظهر في نظام الملفات
    const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    const sub = new Date().toISOString().slice(0, 7); // مجلد شهري: 2026-08
    const dir = path.join(env.uploadDir, sub);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, name), buffer);
    return { storedPath: path.join(sub, name) };
  }

  async read(storedPath: string): Promise<Buffer> {
    // منع path traversal — المسار المخزّن لازم يظل داخل uploadDir
    const full = path.resolve(env.uploadDir, storedPath);
    if (!full.startsWith(path.resolve(env.uploadDir))) throw new Error('Invalid storage path');
    return fs.promises.readFile(full);
  }

  async remove(storedPath: string): Promise<void> {
    const full = path.resolve(env.uploadDir, storedPath);
    if (!full.startsWith(path.resolve(env.uploadDir))) throw new Error('Invalid storage path');
    await fs.promises.unlink(full).catch(() => undefined); // حذف صامت لو الملف غير موجود أصلًا
  }
}

export const storage: StorageAdapter = new LocalDiskStorage();
