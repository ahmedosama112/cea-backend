import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { requireRole } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { idParamSchema } from '../utils/crudFactory';

// ═══════════ وحدة المخازن — مخزن واحد مشترك، أونلاين فقط ═══════════
// القواعد:
// - الكمية لا تُعدَّل مباشرة أبدًا: كل تغيير عبر حركة (وارد/صرف/تسوية) داخل transaction.
// - الصرف (OUT) حصريًا عبر تنفيذ طلب صرف معتمد، بشرط كفاية الكمية على مستوى القاعدة.
// - القراءة لكل من عنده وحدة inventory؛ الكتابة في المخزون والاعتماد والصرف للأدمن (أمين المخزن حاليًا).

export const inventoryRoutes = Router();
// ملاحظة: authenticate + requireModule('inventory') بيتطبقوا في routes/index.ts

// ── وحدات القياس: قائمة أساسية ثابتة + إضافات الأدمن (متخزنة في app_config) ──
const BASE_UNITS = ['عدد', 'متر', 'م2', 'م3', 'شيكارة', 'طن', 'كجم', 'لتر', 'لفة', 'عبوة'];
const UNITS_KEY = 'invUnits';

async function readUnits(): Promise<string[]> {
  const row = await prisma.appConfig.findUnique({ where: { key: UNITS_KEY } });
  const extra = row?.value ? row.value.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return [...BASE_UNITS, ...extra.filter((u) => !BASE_UNITS.includes(u))];
}

inventoryRoutes.get(
  '/units',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ success: true, data: await readUnits() });
  }),
);

inventoryRoutes.post(
  '/units',
  requireRole('ADMIN'),
  validate({ body: z.object({ unit: z.string().trim().min(1).max(30) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const units = await readUnits();
    if (!units.includes(req.body.unit)) {
      const row = await prisma.appConfig.findUnique({ where: { key: UNITS_KEY } });
      const extra = row?.value ? row.value + ',' + req.body.unit : req.body.unit;
      if (extra.length > 180) throw AppError.validation('قائمة الوحدات المضافة اتملت — احذف/اختصر قبل الإضافة');
      await prisma.appConfig.upsert({ where: { key: UNITS_KEY }, update: { value: extra }, create: { key: UNITS_KEY, value: extra } });
    }
    res.json({ success: true, data: await readUnits() });
  }),
);

// ── الأصناف ──
const qtySchema = z.coerce.number().min(0).max(9_999_999);

inventoryRoutes.get(
  '/items',
  asyncHandler(async (_req: Request, res: Response) => {
    const items = await prisma.inventoryItem.findMany({ orderBy: { name: 'asc' } });
    res.json({ success: true, data: items });
  }),
);

inventoryRoutes.post(
  '/items',
  requireRole('ADMIN'),
  validate({ body: z.object({ code: z.string().trim().min(1).max(60), name: z.string().trim().min(1).max(190), unit: z.string().trim().min(1).max(60), qty: qtySchema.optional().default(0), minQty: qtySchema.optional().default(0), note: z.string().trim().max(500).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { code, name, unit, qty, minQty, note } = req.body;
    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.inventoryItem.create({ data: { code, name, unit, qty, minQty } });
      // الرصيد الافتتاحي بيتسجل كحركة وارد — عشان دفتر الحركات يفضل مطابق للكمية من أول يوم
      if (qty > 0) await tx.stockMove.create({ data: { itemId: created.id, type: 'IN', qty, byUserId: req.user!.id, note: note || 'رصيد افتتاحي' } });
      return created;
    }).catch((e: { code?: string }) => { if (e.code === 'P2002') throw AppError.validation('الكود ده مستخدم بالفعل لصنف تاني'); throw e; });
    res.status(201).json({ success: true, data: item });
  }),
);

// تعديل بيانات الصنف (مش الكمية — الكمية عبر الحركات فقط)
inventoryRoutes.put(
  '/items/:id',
  requireRole('ADMIN'),
  validate({ params: idParamSchema, body: z.object({ code: z.string().trim().min(1).max(60), name: z.string().trim().min(1).max(190), unit: z.string().trim().min(1).max(60), minQty: qtySchema.optional().default(0) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = BigInt(req.params.id);
    const exists = await prisma.inventoryItem.findUnique({ where: { id } });
    if (!exists) throw AppError.notFound('الصنف غير موجود');
    const item = await prisma.inventoryItem
      .update({ where: { id }, data: { code: req.body.code, name: req.body.name, unit: req.body.unit, minQty: req.body.minQty } })
      .catch((e: { code?: string }) => { if (e.code === 'P2002') throw AppError.validation('الكود ده مستخدم بالفعل لصنف تاني'); throw e; });
    res.json({ success: true, data: item });
  }),
);

// حركة يدوية: وارد (IN بكمية موجبة تُضاف) أو تسوية جرد (ADJUST بالعدد الفعلي الجديد على الرف — بسبب إلزامي)
inventoryRoutes.post(
  '/items/:id/move',
  requireRole('ADMIN'),
  validate({ params: idParamSchema, body: z.object({ type: z.enum(['IN', 'ADJUST']), qty: qtySchema, note: z.string().trim().max(500).optional().default('') }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = BigInt(req.params.id);
    const { type, qty, note } = req.body;
    if (type === 'IN' && qty <= 0) throw AppError.validation('كمية الوارد لازم تكون أكبر من صفر');
    if (type === 'ADJUST' && !note) throw AppError.validation('تسوية الجرد لازم لها سبب مكتوب');
    const item = await prisma.$transaction(async (tx) => {
      const cur = await tx.inventoryItem.findUnique({ where: { id } });
      if (!cur) throw AppError.notFound('الصنف غير موجود');
      const newQty = type === 'IN' ? Number(cur.qty) + qty : qty; // ADJUST = العدد الفعلي الجديد
      const moveQty = type === 'IN' ? qty : qty - Number(cur.qty); // التسوية بتتسجل بالفرق (+/-)
      await tx.stockMove.create({ data: { itemId: id, type, qty: moveQty, byUserId: req.user!.id, note: note || null } });
      return tx.inventoryItem.update({ where: { id }, data: { qty: newQty } });
    });
    res.json({ success: true, data: item });
  }),
);

// آخر حركات صنف (للتدقيق)
inventoryRoutes.get(
  '/items/:id/moves',
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const moves = await prisma.stockMove.findMany({
      where: { itemId: BigInt(req.params.id) },
      include: { byUser: { select: { email: true, title: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ success: true, data: moves });
  }),
);

// ── طلبات الصرف ──
const linesSchema = z.array(z.object({ itemId: z.coerce.bigint(), qty: qtySchema.refine((v) => v > 0, 'الكمية لازم أكبر من صفر') })).min(1, 'أضف صنف واحد على الأقل').max(50);

const ISSUE_INCLUDE = {
  lines: { include: { item: { select: { code: true, name: true, unit: true, qty: true } } } },
  user: { select: { email: true, title: true } },
} as const;

inventoryRoutes.get(
  '/issue-requests',
  asyncHandler(async (req: Request, res: Response) => {
    const mineOnly = req.user!.role !== 'ADMIN' || req.query.mine === '1';
    const rows = await prisma.issueRequest.findMany({
      where: mineOnly ? { userId: req.user!.id } : {},
      include: ISSUE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ success: true, data: rows });
  }),
);

inventoryRoutes.post(
  '/issue-requests',
  validate({ body: z.object({ lines: linesSchema, note: z.string().trim().max(500).optional().default('') }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const lines = req.body.lines as Array<{ itemId: bigint; qty: number }>;
    // قرار صاحب المشروع: لو الكمية غير كافية وقت الطلب → يُرفض الطلب فورًا ويتوجه لطلب شراء
    const items = await prisma.inventoryItem.findMany({ where: { id: { in: lines.map((l) => l.itemId) } } });
    const byId = new Map(items.map((i) => [i.id.toString(), i]));
    for (const l of lines) {
      const item = byId.get(l.itemId.toString());
      if (!item) throw AppError.validation('صنف غير موجود في المخزن');
      if (Number(item.qty) < l.qty) {
        throw AppError.validation(`الكمية غير كافية من "${item.name}" — المتاح ${Number(item.qty)} ${item.unit}. اعمل طلب شراء أو تواصل مع مدير التنفيذ`);
      }
    }
    const created = await prisma.issueRequest.create({
      data: { userId: req.user!.id, note: req.body.note || null, lines: { create: lines.map((l) => ({ itemId: l.itemId, qty: l.qty })) } },
      include: ISSUE_INCLUDE,
    });
    res.status(201).json({ success: true, data: created });
  }),
);

inventoryRoutes.patch(
  '/issue-requests/:id/review',
  requireRole('ADMIN'),
  validate({ params: idParamSchema, body: z.object({ status: z.enum(['APPROVED', 'REJECTED', 'SUBMITTED']), reviewNote: z.string().trim().max(500).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = BigInt(req.params.id);
    const cur = await prisma.issueRequest.findUnique({ where: { id } });
    if (!cur) throw AppError.notFound('الطلب غير موجود');
    if (cur.status === 'FULFILLED') throw AppError.validation('الطلب اتصرف بالفعل — مينفعش تعديل حالته');
    const row = await prisma.issueRequest.update({
      where: { id },
      data: {
        status: req.body.status,
        reviewNote: req.body.reviewNote ?? null,
        reviewedById: req.body.status === 'SUBMITTED' ? null : req.user!.id,
        reviewedAt: req.body.status === 'SUBMITTED' ? null : new Date(),
      },
      include: ISSUE_INCLUDE,
    });
    res.json({ success: true, data: row });
  }),
);

// تنفيذ الصرف الفعلي: خصم الكميات + حركات OUT — كله transaction واحدة بشرط الكفاية
inventoryRoutes.post(
  '/issue-requests/:id/fulfill',
  requireRole('ADMIN'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = BigInt(req.params.id);
    const request = await prisma.issueRequest.findUnique({ where: { id }, include: { lines: { include: { item: true } } } });
    if (!request) throw AppError.notFound('الطلب غير موجود');
    if (request.status !== 'APPROVED') throw AppError.validation('لازم الطلب يكون معتمدًا الأول قبل الصرف');
    await prisma.$transaction(async (tx) => {
      for (const line of request.lines) {
        // الشرط qty >= المطلوب على مستوى القاعدة نفسها — طلبان متزامنان على آخر كمية: واحد بس هينجح
        const updated = await tx.inventoryItem.updateMany({
          where: { id: line.itemId, qty: { gte: line.qty } },
          data: { qty: { decrement: line.qty } },
        });
        if (updated.count === 0) throw AppError.validation(`الكمية غير كافية من "${line.item.name}" — المتاح دلوقتي ${Number(line.item.qty)} ${line.item.unit}`);
        await tx.stockMove.create({ data: { itemId: line.itemId, type: 'OUT', qty: Number(line.qty), byUserId: req.user!.id, issueRequestId: id, note: 'صرف طلب #' + id.toString() } });
      }
      await tx.issueRequest.update({ where: { id }, data: { status: 'FULFILLED', fulfilledAt: new Date() } });
    });
    const fresh = await prisma.issueRequest.findUnique({ where: { id }, include: ISSUE_INCLUDE });
    res.json({ success: true, data: fresh });
  }),
);

// المهندس يحذف طلبه طالما لسه "مُرسَل"
inventoryRoutes.delete(
  '/issue-requests/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const row = await prisma.issueRequest.findFirst({ where: { id: BigInt(req.params.id), userId: req.user!.id } });
    if (!row) throw AppError.notFound('الطلب غير موجود');
    if (row.status !== 'SUBMITTED') throw AppError.validation('مينفعش حذف طلب تمت مراجعته');
    await prisma.issueRequest.delete({ where: { id: row.id } });
    res.json({ success: true, data: null });
  }),
);

// ── طلبات الشراء ──
const PURCHASE_INCLUDE = {
  item: { select: { code: true, name: true, unit: true, qty: true } },
  byUser: { select: { email: true, title: true } },
} as const;

inventoryRoutes.get(
  '/purchase-requests',
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await prisma.purchaseRequest.findMany({ include: PURCHASE_INCLUDE, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json({ success: true, data: rows });
  }),
);

inventoryRoutes.post(
  '/purchase-requests',
  validate({ body: z.object({ itemId: z.coerce.bigint(), qtyRequested: qtySchema.refine((v) => v > 0, 'الكمية لازم أكبر من صفر'), note: z.string().trim().max(500).optional().default('') }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const item = await prisma.inventoryItem.findUnique({ where: { id: req.body.itemId } });
    if (!item) throw AppError.notFound('الصنف غير موجود');
    const row = await prisma.purchaseRequest.create({
      // لقطة الكمية وقت الطلب — تفضل ظاهرة حتى لو المخزون اتغير بعدها
      data: { itemId: item.id, qtyRequested: req.body.qtyRequested, qtyAtRequest: item.qty, byUserId: req.user!.id, note: req.body.note || null },
      include: PURCHASE_INCLUDE,
    });
    res.status(201).json({ success: true, data: row });
  }),
);

inventoryRoutes.patch(
  '/purchase-requests/:id',
  requireRole('ADMIN'),
  validate({ params: idParamSchema, body: z.object({ status: z.enum(['PURCHASED', 'CANCELLED', 'OPEN']) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = BigInt(req.params.id);
    const exists = await prisma.purchaseRequest.findUnique({ where: { id } });
    if (!exists) throw AppError.notFound('الطلب غير موجود');
    const row = await prisma.purchaseRequest.update({
      where: { id },
      data: { status: req.body.status, resolvedAt: req.body.status === 'OPEN' ? null : new Date() },
      include: PURCHASE_INCLUDE,
    });
    res.json({ success: true, data: row });
  }),
);
