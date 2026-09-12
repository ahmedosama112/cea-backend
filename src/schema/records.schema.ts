import { z } from 'zod';
import { rateTypeArSchema } from '../utils/rateType';
import { ymdDate } from './entities.schema';

// نفس حقول فورم saveRecord في app.js حرفيًا (contractor/place بالاسم، deductOn مصفوفة أسماء)
export const recordCreateSchema = z.object({
  day: z.string().trim().min(1, 'اختر اليوم').max(20),
  date: ymdDate,
  contractor: z.string().trim().min(1, 'اختر المقاول').max(190),
  spec: z.string().trim().max(190).optional().default(''),
  // (L3) finite + سقف منطقي — بدونهم Infinity كانت بتتقبل وتبوظ الحسابات
  qty: z.coerce.number().finite().positive('أدخل الكمية').max(1_000_000),
  qtyType: rateTypeArSchema.optional().default('يومية'),
  price: z.coerce.number().finite().min(0).max(100_000_000),
  discount: z.coerce.number().finite().min(0).max(100_000_000).optional().default(0),
  place: z.string().trim().max(190).optional().default(''),
  notes: z.string().trim().max(5000).optional().default(''),
  deductOn: z.array(z.string().trim().min(1).max(190)).optional().default([]),
  deductNote: z.string().trim().max(255).optional().default(''),
  done: z.boolean().optional().default(false),
  // ربط السجل بطلب إيجار معتمد (اختياري). التحقق من الملكية/الاعتماد/عدم التكرار
  // في recordsService.resolveRentRequest، والضمان النهائي قيد @unique في قاعدة البيانات.
  rentRequestId: z.coerce.number().int().positive().nullable().optional(),
});

export const recordUpdateSchema = recordCreateSchema.partial();

export const recordListQuerySchema = z.object({
  date_from: ymdDate.optional(),
  date_to: ymdDate.optional(),
  contractor: z.string().trim().max(190).optional(),
  place: z.string().trim().max(190).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(500).optional().default(200),
  sort: z.enum(['date', 'contractor', 'total']).optional().default('date'),
  dir: z.enum(['asc', 'desc']).optional().default('desc'),
});
