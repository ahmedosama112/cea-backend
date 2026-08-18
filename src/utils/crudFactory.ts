import { Router } from 'express';
import { Request, Response } from 'express';
import { AnyZodObject } from 'zod';
import { z } from 'zod';
import { AppError } from './AppError';
import { asyncHandler } from './asyncHandler';
import { authenticate, requireRole } from '../middlewares/auth';
import { validate } from '../middlewares/validate';

export const idParamSchema = z.object({ id: z.coerce.bigint() });

// واجهة موحدة لأي Prisma delegate بسيط (contractors, places, inspectors, todos, ir_records...)
// كل الاستعلامات مقيّدة بـ userId — ownership يُفرض هنا على مستوى الـ repository وليس الواجهة
interface SimpleDelegate {
  findMany(args: unknown): Promise<unknown[]>;
  findFirst(args: unknown): Promise<unknown | null>;
  create(args: unknown): Promise<unknown>;
  update(args: unknown): Promise<unknown>;
  delete(args: unknown): Promise<unknown>;
}

interface CrudOptions {
  delegate: SimpleDelegate;
  createSchema: AnyZodObject;
  updateSchema: AnyZodObject;
  orderBy?: Record<string, 'asc' | 'desc'>;
  // تحويل الـ body المُتحقق منه إلى حقول Prisma (مثلاً date نص → Date)
  toData?: (body: Record<string, unknown>) => Record<string, unknown>;
  // تحويل الصفوف قبل الإرسال (مثلاً enum → النص العربي المطابق للواجهة)
  serialize?: <T>(rows: T) => T;
  // لو محدد: عمليات الكتابة (POST/PUT/DELETE) مقصورة على هذه الأدوار — القراءة متاحة للجميع
  writeRoles?: Array<'ADMIN' | 'ENGINEER'>;
}

async function findOwnedOrThrow(delegate: SimpleDelegate, id: bigint, userId: bigint) {
  const row = await delegate.findFirst({ where: { id, userId } });
  if (!row) throw AppError.notFound();
  return row;
}

// مصنع CRUD موحد: GET /  GET /:id  POST /  PUT /:id  DELETE /:id
// كلها خلف authenticate وكلها مقيدة ببيانات المستخدم صاحب التوكن فقط
export function crudRouter(opts: CrudOptions): Router {
  const { delegate, createSchema, updateSchema, orderBy, toData = (b) => b, serialize = <T,>(r: T) => r, writeRoles } = opts;
  const router = Router();
  router.use(authenticate);
  const writeGuard = writeRoles ? [requireRole(...writeRoles)] : [];

  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const rows = await delegate.findMany({
        where: { userId: req.user!.id },
        ...(orderBy ? { orderBy } : {}),
      });
      res.json({ success: true, data: serialize(rows) });
    }),
  );

  router.get(
    '/:id',
    validate({ params: idParamSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      const row = await findOwnedOrThrow(delegate, BigInt(req.params.id), req.user!.id);
      res.json({ success: true, data: serialize(row) });
    }),
  );

  router.post(
    '/',
    ...writeGuard,
    validate({ body: createSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      const row = await delegate.create({ data: { ...toData(req.body), userId: req.user!.id } });
      res.status(201).json({ success: true, data: serialize(row) });
    }),
  );

  router.put(
    '/:id',
    ...writeGuard,
    validate({ params: idParamSchema, body: updateSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      const id = BigInt(req.params.id);
      await findOwnedOrThrow(delegate, id, req.user!.id);
      const row = await delegate.update({ where: { id }, data: toData(req.body) });
      res.json({ success: true, data: serialize(row) });
    }),
  );

  router.delete(
    '/:id',
    ...writeGuard,
    validate({ params: idParamSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      const id = BigInt(req.params.id);
      await findOwnedOrThrow(delegate, id, req.user!.id);
      await delegate.delete({ where: { id } });
      res.json({ success: true, data: null });
    }),
  );

  return router;
}
