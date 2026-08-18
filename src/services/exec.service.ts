import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';

interface ExecStageInput { name: string; pct: number; done: boolean }
interface ExecInput { item: string; place: string; pct: number; notes: string; stages: ExecStageInput[] }

const includeStages = { stages: { select: { name: true, pct: true, done: true } } };

type ExecRow = { id: bigint; item: string; place: string; pct: Prisma.Decimal; notes: string | null; updatedAt: Date; stages: Array<{ name: string; pct: number; done: boolean }> };

// نفس شكل execRecords في الواجهة: stages snapshot + stageDone مصفوفة booleans + updated بتاريخ YYYY-MM-DD
export function execToApiShape(row: ExecRow) {
  return {
    id: row.id.toString(),
    item: row.item,
    place: row.place,
    pct: Number(row.pct),
    notes: row.notes ?? '',
    stages: row.stages.map((s) => ({ name: s.name, pct: s.pct })),
    stageDone: row.stages.map((s) => s.done),
    updated: row.updatedAt.toISOString().split('T')[0],
  };
}

export const execService = {
  async list(userId: bigint) {
    const rows = await prisma.execRecord.findMany({ where: { userId }, include: includeStages, orderBy: { updatedAt: 'desc' } });
    return rows.map(execToApiShape);
  },

  async getOwned(userId: bigint, id: bigint) {
    const row = await prisma.execRecord.findFirst({ where: { id, userId }, include: includeStages });
    if (!row) throw AppError.notFound('سجل الموقف التنفيذي غير موجود');
    return row;
  },

  async create(userId: bigint, input: ExecInput) {
    const row = await prisma.execRecord.create({
      data: {
        userId,
        item: input.item,
        place: input.place,
        pct: new Prisma.Decimal(input.pct),
        notes: input.notes,
        stages: { create: input.stages },
      },
      include: includeStages,
    });
    return execToApiShape(row);
  },

  async update(userId: bigint, id: bigint, input: ExecInput) {
    await this.getOwned(userId, id);
    const row = await prisma.execRecord.update({
      where: { id },
      data: {
        item: input.item,
        place: input.place,
        pct: new Prisma.Decimal(input.pct),
        notes: input.notes,
        stages: { deleteMany: {}, create: input.stages },
      },
      include: includeStages,
    });
    return execToApiShape(row);
  },

  async remove(userId: bigint, id: bigint) {
    await this.getOwned(userId, id);
    await prisma.execRecord.delete({ where: { id } });
  },
};
