import { prisma } from '../config/prisma';
import { crudRouter } from '../utils/crudFactory';
import { arabizeRateTypes, toEnum, RateTypeAr } from '../utils/rateType';
import { checkAndSyncPlaceSite } from '../services/placeSite';
import {
  contractorCreateSchema,
  contractorUpdateSchema,
  inspectorCreateSchema,
  inspectorUpdateSchema,
  irCreateSchema,
  irUpdateSchema,
  equipmentCreateSchema,
  equipmentUpdateSchema,
  minutesBetween,
  placeCreateSchema,
  placeUpdateSchema,
  todoCreateSchema,
  todoUpdateSchema,
} from '../schema/entities.schema';

// كل راوتر هنا CRUD قياسي مملوك للمستخدم — بديل مباشر للمصفوفات التي كانت JSON blobs في cea_sync_meta

// المقاولون: بيانات مرجعية يديرها الأدمن (زي الأماكن) — المهندس يقرأها ويستخدمها فقط
// الأدمن يزرعها في حسابات المهندسين عبر /api/admin/users/:userId/contractors
export const contractorsRouter = crudRouter({
  delegate: prisma.contractor,
  createSchema: contractorCreateSchema,
  updateSchema: contractorUpdateSchema,
  orderBy: { name: 'asc' },
  toData: (b) => ({ ...b, ...(b.rateType ? { rateType: toEnum(b.rateType as RateTypeAr) } : {}) }),
  serialize: arabizeRateTypes,
  writeRoles: ['ADMIN'],
});

// الأماكن: المهندس يقرأها فقط — الإضافة/التعديل/الحذف للأدمن (بديل حماية الـ PIN بس على مستوى السيرفر)
// الأدمن يديرها في حسابات المهندسين عبر /api/admin/users/:userId/places
export const placesRouter = crudRouter({
  delegate: prisma.place,
  createSchema: placeCreateSchema,
  updateSchema: placeUpdateSchema,
  orderBy: { name: 'asc' },
  writeRoles: ['ADMIN'],
  beforeWrite: async (body, ctx) => {
    if (ctx.id === undefined) {
      if (body.site === null || body.site === undefined) body.site = 1;
    } else if (body.site === null) {
      body.site = 1;
    }
    const existing = ctx.id !== undefined ? await prisma.place.findUnique({ where: { id: ctx.id }, select: { id: true, name: true, site: true } }) : null;
    await checkAndSyncPlaceSite(body.name as string, body.site as number | null | undefined, existing ?? undefined);
  },
});

export const inspectorsRouter = crudRouter({
  delegate: prisma.inspector,
  createSchema: inspectorCreateSchema,
  updateSchema: inspectorUpdateSchema,
  orderBy: { name: 'asc' },
});

export const irRouter = crudRouter({
  delegate: prisma.irRecord,
  createSchema: irCreateSchema,
  updateSchema: irUpdateSchema,
  orderBy: { date: 'desc' },
  toData: (b) => ({ ...b, ...(b.date ? { date: new Date(b.date as string) } : {}) }),
});

// سركي المعدات — سطر لكل يوم تشغيل. minutes دايمًا من السيرفر (PUT بيبعت السجل كامل زي saveRecord)
export const equipmentRouter = crudRouter({
  delegate: prisma.equipmentRecord,
  createSchema: equipmentCreateSchema,
  updateSchema: equipmentUpdateSchema,
  orderBy: { date: 'desc' },
  toData: (b) => {
    const out: Record<string, unknown> = { ...b };
    delete out.minutes;
    if (b.date) out.date = new Date(b.date as string);
    if (b.timeFrom && b.timeTo) out.minutes = minutesBetween(b.timeFrom as string, b.timeTo as string);
    return out;
  },
});

export const todosRouter = crudRouter({
  delegate: prisma.todo,
  createSchema: todoCreateSchema,
  updateSchema: todoUpdateSchema,
  orderBy: { date: 'asc' },
  toData: (b) => ({ ...b, ...(b.date ? { date: new Date(b.date as string) } : {}) }),
});
