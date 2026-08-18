import { z } from 'zod';
import { ymdDate } from './entities.schema';

// مراحل البند: نفس شكل items[].stages في app.js — اسم + نسبة مئوية
const stageSchema = z.object({
  name: z.string().trim().min(1, 'أدخل اسم المرحلة').max(190),
  pct: z.coerce.number().int().min(1).max(100),
});

export const itemCreateSchema = z.object({
  cat: z.string().trim().max(190).optional().default('عام'),
  name: z.string().trim().min(1, 'أدخل اسم البند').max(255),
  stages: z.array(stageSchema).optional().default([]),
});
export const itemUpdateSchema = itemCreateSchema;

// الموقف التنفيذي: نفس شكل execRecords في app.js (stages snapshot + stageDone)
const execStageSchema = z.object({
  name: z.string().trim().min(1).max(190),
  pct: z.coerce.number().int().min(0).max(100),
  done: z.boolean().optional().default(false),
});

export const execCreateSchema = z.object({
  item: z.string().trim().min(1, 'اختر البند').max(255),
  place: z.string().trim().min(1, 'اختر المكان').max(190),
  pct: z.coerce.number().min(0).max(100),
  notes: z.string().trim().max(5000).optional().default(''),
  stages: z.array(execStageSchema).optional().default([]),
});
export const execUpdateSchema = execCreateSchema;

export const dailyCreateSchema = z.object({
  date: ymdDate,
  day: z.string().trim().min(1).max(20),
  contractor: z.string().trim().max(190).optional().default(''),
  spec: z.string().trim().max(190).optional().default(''),
  work: z.string().trim().max(10000).optional().default(''),
  place: z.string().trim().max(190).optional().default(''),
  photoFileId: z.coerce.bigint().optional().nullable(),
});
export const dailyUpdateSchema = dailyCreateSchema;
