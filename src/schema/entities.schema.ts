import { z } from 'zod';
import { rateTypeArSchema } from '../utils/rateType';

// تاريخ بصيغة YYYY-MM-DD كما ترسله الواجهة الحالية بالظبط
export const ymdDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD');

// ── المقاولون ──
export const contractorCreateSchema = z.object({
  name: z.string().trim().min(1, 'أدخل إسم المقاول').max(190),
  spec: z.string().trim().max(190).optional().default('—'),
  rate: z.coerce.number().min(0).optional().nullable(),
  rateType: rateTypeArSchema.optional().default('يومية'),
});
export const contractorUpdateSchema = contractorCreateSchema.partial();

// ── الأماكن ──
export const placeCreateSchema = z.object({
  name: z.string().trim().min(1, 'أدخل إسم المكان').max(190),
});
export const placeUpdateSchema = placeCreateSchema;

// ── الاستشاريون ──
export const inspectorCreateSchema = z.object({
  name: z.string().trim().min(1, 'أدخل إسم الاستشاري').max(190),
});
export const inspectorUpdateSchema = inspectorCreateSchema;

// ── طلبات الفحص (IR) — نفس حقول saveIR في app.js ──
export const irCreateSchema = z.object({
  date: ymdDate,
  item: z.string().trim().min(1, 'اختر البند').max(255),
  place: z.string().trim().min(1, 'اختر المكان').max(190),
  inspector: z.string().trim().min(1, 'اختر الاستشاري').max(190),
  status: z.string().trim().min(1).max(50),
  notes: z.string().trim().max(5000).optional().default(''),
});
export const irUpdateSchema = irCreateSchema.partial();

// ── المهام — نفس حقول saveTodo في app.js ──
export const todoCreateSchema = z.object({
  date: ymdDate,
  notes: z.string().trim().min(1, 'اكتب نص المهمة').max(5000),
  place: z.string().trim().max(190).optional().default(''),
  priority: z.string().trim().min(1).max(20),
  done: z.boolean().optional().default(false),
});
export const todoUpdateSchema = todoCreateSchema.partial();
