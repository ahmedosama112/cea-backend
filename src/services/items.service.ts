import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';

interface StageInput { name: string; pct: number }
interface ItemInput { cat: string; name: string; stages: StageInput[] }

const includeStages = { stages: { orderBy: { position: 'asc' as const }, select: { name: true, pct: true } } };

// إعادة تشكيل صف الـ DB لنفس شكل items في الواجهة الحالية: {cat, name, stages:[{name,pct}]}
export function itemToApiShape(row: { id: bigint; category: string; name: string; stages: Array<{ name: string; pct: number }> }) {
  return { id: row.id.toString(), cat: row.category, name: row.name, stages: row.stages };
}

export const itemsService = {
  async list(userId: bigint) {
    const rows = await prisma.item.findMany({ where: { userId }, include: includeStages, orderBy: [{ category: 'asc' }, { name: 'asc' }] });
    return rows.map(itemToApiShape);
  },

  async getOwned(userId: bigint, id: bigint) {
    const row = await prisma.item.findFirst({ where: { id, userId }, include: includeStages });
    if (!row) throw AppError.notFound('البند غير موجود');
    return row;
  },

  async create(userId: bigint, input: ItemInput) {
    const row = await prisma.item.create({
      data: {
        userId,
        category: input.cat,
        name: input.name,
        stages: { create: input.stages.map((s, i) => ({ ...s, position: i })) },
      },
      include: includeStages,
    });
    return itemToApiShape(row);
  },

  async update(userId: bigint, id: bigint, input: ItemInput) {
    await this.getOwned(userId, id);
    const row = await prisma.item.update({
      where: { id },
      data: {
        category: input.cat,
        name: input.name,
        // استبدال كامل للمراحل — نفس سلوك saveEditItem في الواجهة
        stages: { deleteMany: {}, create: input.stages.map((s, i) => ({ ...s, position: i })) },
      },
      include: includeStages,
    });
    return itemToApiShape(row);
  },

  async remove(userId: bigint, id: bigint) {
    await this.getOwned(userId, id);
    await prisma.item.delete({ where: { id } });
  },
};
