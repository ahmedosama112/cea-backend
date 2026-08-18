import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { toEnum, RateTypeAr } from '../utils/rateType';

// الإجمالي يُحسب دائمًا على السيرفر بنفس معادلة calcTotal في app.js:
// total = qty × price − discount — لا نثق بأي total قادم من العميل
function computeTotal(qty: number, price: number, discount: number): Prisma.Decimal {
  return new Prisma.Decimal(qty).mul(price).minus(discount);
}

interface RecordInput {
  day: string;
  date: string;
  contractor: string;
  spec: string;
  qty: number;
  qtyType: RateTypeAr;
  price: number;
  discount: number;
  place: string;
  notes: string;
  deductOn: string[];
  deductNote: string;
  done: boolean;
}

// يحاول ربط الاسم النصي بمقاول/مكان فعلي للمستخدم — الاسم يبقى محفوظًا كنسخة snapshot
// حتى لو حُذف المقاول لاحقًا فلا تنكسر السجلات التاريخية (نفس سلوك التطبيق الحالي)
async function resolveRefs(userId: bigint, contractorName: string, placeName: string) {
  const [contractor, place] = await Promise.all([
    contractorName ? prisma.contractor.findFirst({ where: { userId, name: contractorName } }) : null,
    placeName ? prisma.place.findFirst({ where: { userId, name: placeName } }) : null,
  ]);
  return { contractorId: contractor?.id ?? null, placeId: place?.id ?? null };
}

function toDbData(userId: bigint, input: RecordInput) {
  return {
    userId,
    day: input.day,
    date: new Date(input.date),
    contractorName: input.contractor,
    placeName: input.place,
    spec: input.spec,
    qty: new Prisma.Decimal(input.qty),
    qtyType: toEnum(input.qtyType),
    price: new Prisma.Decimal(input.price),
    discount: new Prisma.Decimal(input.discount),
    total: computeTotal(input.qty, input.price, input.discount),
    notes: input.notes,
    deductNote: input.deductNote,
    done: input.done,
  };
}

const includeDeductions = { deductions: { select: { name: true } } };

export const recordsService = {
  async list(userId: bigint, q: {
    date_from?: string; date_to?: string; contractor?: string; place?: string;
    page: number; limit: number; sort: 'date' | 'contractor' | 'total'; dir: 'asc' | 'desc';
  }) {
    const where: Prisma.RecordWhereInput = {
      userId,
      ...(q.date_from || q.date_to
        ? { date: { ...(q.date_from ? { gte: new Date(q.date_from) } : {}), ...(q.date_to ? { lte: new Date(q.date_to) } : {}) } }
        : {}),
      ...(q.contractor ? { contractorName: q.contractor } : {}),
      ...(q.place ? { placeName: q.place } : {}),
    };
    const sortField = q.sort === 'contractor' ? 'contractorName' : q.sort;
    const [total, rows] = await Promise.all([
      prisma.record.count({ where }),
      prisma.record.findMany({
        where,
        include: includeDeductions,
        orderBy: { [sortField]: q.dir },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    return { total, page: q.page, limit: q.limit, rows };
  },

  async getOwned(userId: bigint, id: bigint) {
    const row = await prisma.record.findFirst({ where: { id, userId }, include: includeDeductions });
    if (!row) throw AppError.notFound('السجل غير موجود');
    return row;
  },

  async create(userId: bigint, input: RecordInput) {
    const refs = await resolveRefs(userId, input.contractor, input.place);
    return prisma.record.create({
      data: {
        ...toDbData(userId, input),
        ...refs,
        deductions: { create: input.deductOn.map((name) => ({ name })) },
      },
      include: includeDeductions,
    });
  },

  async update(userId: bigint, id: bigint, input: RecordInput) {
    await this.getOwned(userId, id);
    const refs = await resolveRefs(userId, input.contractor, input.place);
    return prisma.record.update({
      where: { id },
      data: {
        ...toDbData(userId, input),
        ...refs,
        // استبدال كامل لقائمة الخصومات — نفس سلوك تعديل السجل في الواجهة
        deductions: { deleteMany: {}, create: input.deductOn.map((name) => ({ name })) },
      },
      include: includeDeductions,
    });
  },

  async toggleDone(userId: bigint, id: bigint) {
    const row = await this.getOwned(userId, id);
    return prisma.record.update({ where: { id }, data: { done: !row.done }, include: includeDeductions });
  },

  async remove(userId: bigint, id: bigint) {
    await this.getOwned(userId, id);
    await prisma.record.delete({ where: { id } });
  },
};
