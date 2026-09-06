import { z } from 'zod';
import { rateTypeArSchema } from '../utils/rateType';

// تاريخ بصيغة YYYY-MM-DD كما ترسله الواجهة الحالية بالظبط
// (L3) + تحقق إنه تاريخ تقويمي حقيقي — الـ regex وحده كان بيقبل 2026-99-99
export const ymdDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(s + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'تاريخ غير صحيح');

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
  // ملاحظة اختيارية — بتظهر للمهندس جنب اختيار المكان في تسجيل السركي
  note: z.string().trim().max(500).optional().nullable(),
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

// ── سركي المعدات — نفس حقول saveEquipment في app.js ──
// الوقت "HH:MM" (24 ساعة). المدة (minutes) بتتحسب في السيرفر — أي قيمة مُرسلة بتتجاهل.
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'الوقت يجب أن يكون بصيغة HH:MM');
export const equipmentCreateSchema = z.object({
  date: ymdDate,
  day: z.string().trim().min(1, 'اليوم مطلوب').max(20),
  contractor: z.string().trim().min(1, 'اختر المقاول').max(190),
  equipment: z.string().trim().min(1, 'اكتب اسم المعدة').max(190),
  place: z.string().trim().min(1, 'اختر المكان').max(190),
  timeFrom: hhmm,
  timeTo: hhmm,
  works: z.string().trim().max(5000).optional().default(''),
  notes: z.string().trim().max(500).optional().default(''),
});
export const equipmentUpdateSchema = equipmentCreateSchema.partial();

// المدة بالدقائق من "من/إلى": لو "إلى" أصغر من "من" = الوردية عدّت نص الليل (مثلاً 22:00 → 06:00 = 8 ساعات)
export function minutesBetween(from: string, to: string): number {
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  let d = th * 60 + tm - (fh * 60 + fm);
  if (d < 0) d += 24 * 60;
  return d;
}

// ── المهام — نفس حقول saveTodo في app.js ──
export const todoCreateSchema = z.object({
  date: ymdDate,
  notes: z.string().trim().min(1, 'اكتب نص المهمة').max(5000),
  place: z.string().trim().max(190).optional().default(''),
  priority: z.string().trim().min(1).max(20),
  done: z.boolean().optional().default(false),
});
export const todoUpdateSchema = todoCreateSchema.partial();
