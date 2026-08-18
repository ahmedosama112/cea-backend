import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';

interface DailyInput {
  date: string;
  day: string;
  contractor: string;
  spec: string;
  work: string;
  place: string;
  photoFileId?: bigint | null;
}

function toApiShape(row: { id: bigint; date: Date; photoFileId: bigint | null } & Record<string, unknown>) {
  return {
    ...row,
    id: row.id.toString(),
    date: row.date.toISOString().split('T')[0],
    photoFileId: row.photoFileId ? row.photoFileId.toString() : null,
  };
}

// الصورة المرفقة لازم تكون ملف مملوك لنفس المستخدم — وإلا يقدر يربط ملفات الآخرين بسجلاته
async function assertPhotoOwned(userId: bigint, photoFileId?: bigint | null) {
  if (!photoFileId) return;
  const file = await prisma.file.findFirst({ where: { id: photoFileId, userId } });
  if (!file) throw AppError.validation('الملف المرفق غير موجود');
}

export const dailyService = {
  async list(userId: bigint) {
    const rows = await prisma.dailyRecord.findMany({ where: { userId }, orderBy: { date: 'desc' } });
    return rows.map(toApiShape);
  },

  async getOwned(userId: bigint, id: bigint) {
    const row = await prisma.dailyRecord.findFirst({ where: { id, userId } });
    if (!row) throw AppError.notFound('التقرير اليومي غير موجود');
    return row;
  },

  async create(userId: bigint, input: DailyInput) {
    await assertPhotoOwned(userId, input.photoFileId);
    const row = await prisma.dailyRecord.create({
      data: { ...input, date: new Date(input.date), userId },
    });
    return toApiShape(row);
  },

  async update(userId: bigint, id: bigint, input: DailyInput) {
    await this.getOwned(userId, id);
    await assertPhotoOwned(userId, input.photoFileId);
    const row = await prisma.dailyRecord.update({
      where: { id },
      data: { ...input, date: new Date(input.date) },
    });
    return toApiShape(row);
  },

  async remove(userId: bigint, id: bigint) {
    await this.getOwned(userId, id);
    await prisma.dailyRecord.delete({ where: { id } });
  },
};
