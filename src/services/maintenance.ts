import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';

// وضع الإيقاف (Service stopped): الأدمن يشغّله ويطفيه من شاشة الإدارة.
// وهو شغال: أي حساب غير الأدمن بياخد 503 MAINTENANCE على كل مسار محمي وعلى الدخول/التجديد،
// والواجهة بتعرض صفحة "Service stopped". الأدمن بيفضل شغال عادي عشان يقدر يطفيه.
const KEY = 'maintenanceMode';
const CACHE_MS = 5_000; // بيتقري مع كل طلب محمي — كاش قصير بدل استعلام لكل طلب (سيرفر واحد)

export interface MaintenanceState {
  on: boolean;
  message: string;
  since: string | null;
}

const OFF: MaintenanceState = { on: false, message: '', since: null };
let cache: { at: number; state: MaintenanceState } | null = null;

function parse(value: string | undefined | null): MaintenanceState {
  if (!value) return OFF;
  try {
    const j = JSON.parse(value) as Partial<MaintenanceState>;
    return {
      on: j.on === true,
      message: typeof j.message === 'string' ? j.message : '',
      since: typeof j.since === 'string' ? j.since : null,
    };
  } catch {
    return OFF;
  }
}

export async function getMaintenance(): Promise<MaintenanceState> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.state;
  // لو القاعدة وقعت لحظيًا ما نقفلش الخدمة على الناس بسبب قراءة فاشلة — نعتبره مطفي
  const row = await prisma.appConfig.findUnique({ where: { key: KEY } }).catch(() => null);
  const state = parse(row?.value);
  cache = { at: Date.now(), state };
  return state;
}

export async function setMaintenance(on: boolean, message: string): Promise<MaintenanceState> {
  const state: MaintenanceState = { on, message: message.trim(), since: on ? new Date().toISOString() : null };
  const value = JSON.stringify(state);
  await prisma.appConfig.upsert({ where: { key: KEY }, update: { value }, create: { key: KEY, value } });
  cache = { at: Date.now(), state };
  return state;
}

export function maintenanceError(state: MaintenanceState) {
  return new AppError(503, 'MAINTENANCE', state.message || 'Service stopped — الخدمة متوقفة مؤقتًا');
}

// للمسارات اللي فيها المستخدم معروف (authenticate، login، refresh): الأدمن دايمًا معدّي
export async function assertServiceOpenFor(role: string) {
  if (role === 'ADMIN') return;
  const state = await getMaintenance();
  if (state.on) throw maintenanceError(state);
}

// للاختبارات بس
export function _resetMaintenanceCache() {
  cache = null;
}
