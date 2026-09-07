import { z } from 'zod';

// الواجهة الأمامية تستخدم النصوص العربية حرفيًا ('يومية' / 'ساعة' / 'مقطوعية') —
// نحوّلها من/إلى أسماء enum في Prisma حتى لا يتغير أي شيء في عقد الـ API مع الواجهة
export const AR_TO_ENUM = { يومية: 'DAILY', ساعة: 'HOURLY', مقطوعية: 'LUMPSUM', عدد: 'COUNT' } as const;
export const ENUM_TO_AR = { DAILY: 'يومية', HOURLY: 'ساعة', LUMPSUM: 'مقطوعية', COUNT: 'عدد' } as const;

export type RateTypeAr = keyof typeof AR_TO_ENUM;
export type RateTypeEnum = keyof typeof ENUM_TO_AR;

export const rateTypeArSchema = z.enum(['يومية', 'ساعة', 'مقطوعية', 'عدد']);

export function toEnum(ar: RateTypeAr): RateTypeEnum {
  return AR_TO_ENUM[ar];
}

// يحوّل حقول rateType/qtyType في صف (أو مصفوفة صفوف) من enum إلى النص العربي قبل الإرسال
export function arabizeRateTypes<T>(rows: T): T {
  const fix = (row: Record<string, unknown>) => {
    for (const key of ['rateType', 'qtyType']) {
      const v = row[key];
      if (typeof v === 'string' && v in ENUM_TO_AR) row[key] = ENUM_TO_AR[v as RateTypeEnum];
    }
    return row;
  };
  if (Array.isArray(rows)) return rows.map((r) => fix(r as Record<string, unknown>)) as T;
  if (rows && typeof rows === 'object') return fix(rows as Record<string, unknown>) as T;
  return rows;
}
