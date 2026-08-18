import { prisma } from '../config/prisma';
import { crudRouter } from '../utils/crudFactory';
import { arabizeRateTypes, toEnum, RateTypeAr } from '../utils/rateType';
import {
  contractorCreateSchema,
  contractorUpdateSchema,
  inspectorCreateSchema,
  inspectorUpdateSchema,
  irCreateSchema,
  irUpdateSchema,
  placeCreateSchema,
  placeUpdateSchema,
  todoCreateSchema,
  todoUpdateSchema,
} from '../schema/entities.schema';

// كل راوتر هنا CRUD قياسي مملوك للمستخدم — بديل مباشر للمصفوفات التي كانت JSON blobs في cea_sync_meta

export const contractorsRouter = crudRouter({
  delegate: prisma.contractor,
  createSchema: contractorCreateSchema,
  updateSchema: contractorUpdateSchema,
  orderBy: { name: 'asc' },
  toData: (b) => ({ ...b, ...(b.rateType ? { rateType: toEnum(b.rateType as RateTypeAr) } : {}) }),
  serialize: arabizeRateTypes,
});

// الأماكن: المهندس يقرأها فقط — الإضافة/التعديل/الحذف للأدمن (بديل حماية الـ PIN بس على مستوى السيرفر)
// الأدمن يديرها في حسابات المهندسين عبر /api/admin/users/:userId/places
export const placesRouter = crudRouter({
  delegate: prisma.place,
  createSchema: placeCreateSchema,
  updateSchema: placeUpdateSchema,
  orderBy: { name: 'asc' },
  writeRoles: ['ADMIN'],
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

export const todosRouter = crudRouter({
  delegate: prisma.todo,
  createSchema: todoCreateSchema,
  updateSchema: todoUpdateSchema,
  orderBy: { date: 'asc' },
  toData: (b) => ({ ...b, ...(b.date ? { date: new Date(b.date as string) } : {}) }),
});
