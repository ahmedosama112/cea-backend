import { Request, Response } from 'express';
import { recordsService } from '../services/records.service';
import { asyncHandler } from '../utils/asyncHandler';
import { arabizeRateTypes } from '../utils/rateType';

// يعيد تشكيل صف الـ DB لنفس شكل الكائن الذي تتعامل معه الواجهة الحالية
// (deductions صفوف → deductOn مصفوفة أسماء، qtyType بالعربي، date نص YYYY-MM-DD)
function toApiShape(row: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...arabizeRateTypes(row) };
  if (row.date instanceof Date) out.date = row.date.toISOString().split('T')[0];
  if (Array.isArray(row.deductions)) {
    out.deductOn = (row.deductions as Array<{ name: string }>).map((d) => d.name);
    delete out.deductions;
  }
  return out;
}

export const recordsController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as never;
    const result = await recordsService.list(req.user!.id, q);
    res.json({
      success: true,
      data: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        rows: result.rows.map((r) => toApiShape(r as unknown as Record<string, unknown>)),
      },
    });
  }),

  get: asyncHandler(async (req: Request, res: Response) => {
    const row = await recordsService.getOwned(req.user!.id, BigInt(req.params.id));
    res.json({ success: true, data: toApiShape(row as unknown as Record<string, unknown>) });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const row = await recordsService.create(req.user!.id, req.body);
    res.status(201).json({ success: true, data: toApiShape(row as unknown as Record<string, unknown>) });
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const row = await recordsService.update(req.user!.id, BigInt(req.params.id), req.body);
    res.json({ success: true, data: toApiShape(row as unknown as Record<string, unknown>) });
  }),

  toggleDone: asyncHandler(async (req: Request, res: Response) => {
    const row = await recordsService.toggleDone(req.user!.id, BigInt(req.params.id));
    res.json({ success: true, data: toApiShape(row as unknown as Record<string, unknown>) });
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await recordsService.remove(req.user!.id, BigInt(req.params.id));
    res.json({ success: true, data: null });
  }),
};
