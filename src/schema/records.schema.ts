import { z } from 'zod';
import { rateTypeArSchema } from '../utils/rateType';
import { ymdDate } from './entities.schema';

// نفس حقول فورم saveRecord في app.js حرفيًا (contractor/place بالاسم، deductOn مصفوفة أسماء)
export const recordCreateSchema = z.object({
  day: z.string().trim().min(1, 'اختر اليوم').max(20),
  date: ymdDate,
  contractor: z.string().trim().min(1, 'اختر المقاول').max(190),
  spec: z.string().trim().max(190).optional().default(''),
  qty: z.coerce.number().positive('أدخل الكمية'),
  qtyType: rateTypeArSchema.optional().default('يومية'),
  price: z.coerce.number().min(0),
  discount: z.coerce.number().min(0).optional().default(0),
  place: z.string().trim().max(190).optional().default(''),
  notes: z.string().trim().max(5000).optional().default(''),
  deductOn: z.array(z.string().trim().min(1).max(190)).optional().default([]),
  deductNote: z.string().trim().max(255).optional().default(''),
  done: z.boolean().optional().default(false),
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
