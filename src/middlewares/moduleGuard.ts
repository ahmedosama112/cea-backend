import { NextFunction, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { ModuleKey, normalizeModules } from '../utils/modules';

// يمنع الوصول لمسارات وحدة غير مفعّلة لحساب المستخدم — الحماية على السيرفر وليس مجرد إخفاء في الواجهة.
// الأدمن مستثنى (هو اللي يدير التفعيل). كاش قصير لتفادي استعلام لكل طلب.
const cache = new Map<string, { modules: ModuleKey[]; at: number }>();
const TTL_MS = 30_000;

export async function enabledModulesFor(userId: bigint): Promise<ModuleKey[]> {
  const key = userId.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.modules;
  const s = await prisma.accountSettings.findUnique({ where: { userId }, select: { enabledModules: true } });
  const modules = normalizeModules(s?.enabledModules);
  cache.set(key, { modules, at: Date.now() });
  return modules;
}
export function invalidateModulesCache(userId: bigint) {
  cache.delete(userId.toString());
}

export function requireModule(module: ModuleKey) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(AppError.unauthorized());
    if (req.user.role === 'ADMIN') return next();
    try {
      const modules = await enabledModulesFor(req.user.id);
      if (!modules.includes(module)) return next(AppError.forbidden('هذه الوحدة غير مفعّلة لحسابك'));
      next();
    } catch (e) {
      next(e);
    }
  };
}
