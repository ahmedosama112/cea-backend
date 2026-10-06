import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middlewares/validate';
import { idParamSchema } from '../utils/crudFactory';
import { ymdDate } from '../schema/entities.schema';
import { rateTypeArSchema, toEnum, arabizeRateTypes, RateTypeAr } from '../utils/rateType';

// ═══════════ طلبات الإيجار (معدات/عمالة) — المهندس يطلب، مدير المشروع يعتمد/يرفض ═══════════
// (authenticate + requireModule('rent_requests') مطبّقين في routes/index.ts)

export const rentRequestsRoutes = Router();

const REVIEW_INCLUDE = {
  user: { select: { email: true, displayName: true, title: true, grade: true } },
  reviews: { orderBy: { createdAt: 'asc' as const }, include: { byUser: { select: { email: true, displayName: true, title: true } } } },
  // السجل اللي استهلك الطلب — الواجهة بتستخدمه تعرض "اتسجّل في السركي" وتمنع استخدامه تاني
  usedByRecord: { select: { id: true } },
} as const;

type ReviewRow = { id: bigint; rentRequestId: bigint; decision: string; note: string | null; byUserId: bigint | null; createdAt: Date; byUser?: unknown };
function shapeReview(r: ReviewRow) {
  return { ...r, id: r.id.toString(), rentRequestId: r.rentRequestId.toString(), byUserId: r.byUserId?.toString() ?? null, createdAt: r.createdAt.toISOString() };
}

type RentRow = {
  id: bigint; userId: bigint; requestNo: string; contractorId: bigint | null; contractorName: string;
  placeId: bigint | null; placeName: string; resourceType: string; statementOfWork: string;
  day: string; date: Date; qty: Prisma.Decimal; qtyType: string; price: Prisma.Decimal; total: Prisma.Decimal;
  status: string; decidedAt: Date | null; decidedById: bigint | null;
  createdAt: Date; updatedAt: Date; reviews?: ReviewRow[];
  user?: { email: string; displayName: string | null; title: string | null; grade: string | null };
  usedByRecord?: { id: bigint } | null;
};
function shape(r: RentRow) {
  return {
    ...arabizeRateTypes(r as unknown as Record<string, unknown>),
    id: r.id.toString(),
    userId: r.userId.toString(),
    contractorId: r.contractorId?.toString() ?? null,
    placeId: r.placeId?.toString() ?? null,
    decidedById: r.decidedById?.toString() ?? null,
    date: r.date.toISOString().slice(0, 10),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    reviews: r.reviews ? r.reviews.map(shapeReview) : undefined,
    usedByRecordId: r.usedByRecord ? r.usedByRecord.id.toString() : null,
  };
}

const STATUS_VALUES = ['PENDING', 'APPROVED', 'APPROVED_NOTES', 'REJECTED'] as const;

// مدير المشروع بيقرر على أي طلب (decide مالوش شرط ملكية) — فلازم يشوف/يفتح كل الطلبات زي الأدمن،
// مش بس اللي هو نفسه طلبها، وإلا مش هيلاقي طلبات المهندسين التانيين عشان يعتمدها أصلًا
async function canSeeAll(req: Request): Promise<boolean> {
  if (req.user!.role === 'ADMIN') return true;
  const me = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { grade: true } });
  return me?.grade === 'project manager';
}

// قائمة الطلبات — المهندس يشوف طلباته هو بس، مدير المشروع والأدمن يشوفوا الكل
rentRequestsRoutes.get(
  '/',
  validate({ query: z.object({ status: z.enum(STATUS_VALUES).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const seeAll = await canSeeAll(req);
    const status = req.query.status as (typeof STATUS_VALUES)[number] | undefined;
    const rows = await prisma.rentRequest.findMany({
      where: { ...(seeAll ? {} : { userId: req.user!.id }), ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: REVIEW_INCLUDE,
    });
    res.json({ success: true, data: rows.map((r) => shape(r as never)) });
  }),
);

// المعتمد (APPROVED + APPROVED_NOTES) — مصدر قايمة "من طلبات الإيجار" في فورم السركي.
// unused=1 بيستبعد الطلبات اللي اتسجّلت في سركي قبل كده، فالطلب بيختفي من القايمة على
// كل الأجهزة (الحالة على السيرفر، مش على الجهاز). نفس نطاق المهندس/الأدمن في القائمة العادية.
rentRequestsRoutes.get(
  '/approved',
  validate({ query: z.object({
    contractorId: z.coerce.bigint().optional(),
    placeId: z.coerce.bigint().optional(),
    resourceType: z.enum(['EQUIPMENT', 'LABOR']).optional(),
    unused: z.enum(['0', '1']).optional(),
  }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const isAdmin = req.user!.role === 'ADMIN';
    const { contractorId, placeId, resourceType, unused } = req.query as { contractorId?: bigint; placeId?: bigint; resourceType?: 'EQUIPMENT' | 'LABOR'; unused?: '0' | '1' };
    const rows = await prisma.rentRequest.findMany({
      where: {
        status: { in: ['APPROVED', 'APPROVED_NOTES'] },
        ...(isAdmin ? {} : { userId: req.user!.id }),
        ...(contractorId ? { contractorId } : {}),
        ...(placeId ? { placeId } : {}),
        ...(resourceType ? { resourceType } : {}),
        ...(unused === '1' ? { usedByRecord: { is: null } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { usedByRecord: { select: { id: true } } },
    });
    res.json({ success: true, data: rows.map((r) => shape(r as never)) });
  }),
);

// طلب جديد — يبدأ PENDING دايمًا. المقاول/المكان لازم يخصّوا صاحب الطلب، واسمهم بيتلقّط كنسخة نصية وقت الطلب
// نفس شكل سطر السركي (Record) بالظبط: يوم/تاريخ/كمية/نوع كمية/سعر — عشان يتقارنوا لاحقًا بسهولة
const createSchema = z.object({
  contractorId: z.coerce.bigint(),
  placeId: z.coerce.bigint(),
  resourceType: z.enum(['EQUIPMENT', 'LABOR']),
  day: z.string().trim().min(1, 'اليوم مطلوب').max(20),
  date: ymdDate,
  qty: z.coerce.number().finite().positive('أدخل الكمية').max(1_000_000),
  qtyType: rateTypeArSchema.optional().default('يومية'),
  price: z.coerce.number().finite().min(0).max(100_000_000),
  statementOfWork: z.string().trim().min(1, 'بيان الأعمال مطلوب').max(2000),
});

// total = qty × price — نفس معادلة computeTotal في records.service.ts بدون خصم (مفيش discount هنا)
function computeTotal(qty: number, price: number): Prisma.Decimal {
  return new Prisma.Decimal(qty).mul(price);
}

rentRequestsRoutes.post(
  '/',
  validate({ body: createSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { contractorId: bigint; placeId: bigint; resourceType: 'EQUIPMENT' | 'LABOR'; day: string; date: string; qty: number; qtyType: RateTypeAr; price: number; statementOfWork: string };
    const contractor = await prisma.contractor.findFirst({ where: { id: body.contractorId, userId: req.user!.id } });
    if (!contractor) throw AppError.validation('المقاول غير موجود أو لا يخصك');
    const place = await prisma.place.findFirst({ where: { id: body.placeId, userId: req.user!.id } });
    if (!place) throw AppError.validation('المكان غير موجود أو لا يخصك');

    // requestNo بيتولّد جوه نفس transaction الإدراج — الترقيم عرضة لتصادم مع طلب متزامن،
    // فبنعتمد على unique constraint كحكم أخير ونعيد المحاولة بدل ما نثق بعدّ مسبق
    let created: RentRow | null = null;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const now = new Date();
      const prefix = `RR-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
      try {
        created = await prisma.$transaction(async (tx) => {
          const count = await tx.rentRequest.count({ where: { requestNo: { startsWith: prefix + '-' } } });
          const requestNo = `${prefix}-${String(count + 1).padStart(4, '0')}`;
          return tx.rentRequest.create({
            data: {
              userId: req.user!.id,
              requestNo,
              contractorId: contractor.id,
              contractorName: contractor.name,
              placeId: place.id,
              placeName: place.name,
              resourceType: body.resourceType,
              statementOfWork: body.statementOfWork,
              day: body.day,
              date: new Date(body.date),
              qty: new Prisma.Decimal(body.qty),
              qtyType: toEnum(body.qtyType),
              price: new Prisma.Decimal(body.price),
              total: computeTotal(body.qty, body.price),
            },
          });
        }) as unknown as RentRow;
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') continue; // تصادم على requestNo — إعادة محاولة برقم جديد
        throw e;
      }
    }
    if (!created) throw AppError.conflict('تعذر توليد رقم الطلب — حاول تاني');
    res.status(201).json({ success: true, data: shape(created) });
  }),
);

// تفاصيل طلب (مع سجل القرارات) — المهندس يشوف طلبه هو بس، مدير المشروع والأدمن يشوفوا أي طلب
rentRequestsRoutes.get(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const seeAll = await canSeeAll(req);
    const row = await prisma.rentRequest.findFirst({
      where: { id: BigInt(req.params.id), ...(seeAll ? {} : { userId: req.user!.id }) },
      include: REVIEW_INCLUDE,
    });
    if (!row) throw AppError.notFound('طلب الإيجار غير موجود');
    res.json({ success: true, data: shape(row as never) });
  }),
);

// قرار اعتماد: معتمد بدون ملاحظات / معتمد بملاحظات / مرفوض — لمدير المشروع أو الأدمن فقط، وعلى طلب PENDING فقط
rentRequestsRoutes.post(
  '/:id/decide',
  validate({ params: idParamSchema, body: z.object({ decision: z.enum(['APPROVED', 'APPROVED_NOTES', 'REJECTED']), note: z.string().trim().max(500).optional().default('') }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = BigInt(req.params.id);
    const decision = req.body.decision as 'APPROVED' | 'APPROVED_NOTES' | 'REJECTED';
    const note = (req.body.note as string) || '';
    if (decision !== 'APPROVED' && !note.trim()) throw AppError.validation('لازم تكتب ملاحظة مع الاعتماد بملاحظات أو الرفض');

    if (!(await canSeeAll(req))) throw AppError.forbidden('الاعتماد على طلبات الإيجار لمدير المشروع فقط');

    const fresh = await prisma.$transaction(async (tx) => {
      const cur = await tx.rentRequest.findUnique({ where: { id } });
      if (!cur) throw AppError.notFound('طلب الإيجار غير موجود');
      if (cur.status !== 'PENDING') throw AppError.validation('الطلب سبق واتقرر فيه — مينفعش يتقرر فيه تاني');
      const claimed = await tx.rentRequest.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: decision, decidedAt: new Date(), decidedById: req.user!.id },
      });
      if (claimed.count === 0) throw AppError.validation('الطلب سبق واتقرر فيه — مينفعش يتقرر فيه تاني');
      await tx.rentRequestReview.create({ data: { rentRequestId: id, decision, note: note.trim() || null, byUserId: req.user!.id } });
      return tx.rentRequest.findUnique({ where: { id }, include: REVIEW_INCLUDE });
    });
    res.json({ success: true, data: shape(fresh as never) });
  }),
);
