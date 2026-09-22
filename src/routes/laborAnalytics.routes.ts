import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middlewares/validate';
import { ymdDate } from '../schema/entities.schema';
import { laborReport, resolveAllScope } from '../services/analytics.service';

// ═══════════ تحليل العمالة — وحدة مستقلة (كل المهندسين، بغض النظر عن الدرجة/الإسناد) ═══════════
// (authenticate + requireModule('labor_analytics') مطبّقين في routes/index.ts)
// نفس تقرير '/api/analytics/labor' بالظبط، لكن النطاق دايمًا 'all' — عشان الحساب ده معاه الوحدة
// دي بس (مش analytics)، فمالوش وصول لباقي أبعاد التحليلات (أماكن/مقاولين/مصفوفة/إجمالي فعلي).

export const laborAnalyticsRoutes = Router();

const filterQuery = z.object({
  from: ymdDate.optional(),
  to: ymdDate.optional(),
  site: z.coerce.number().int().min(1).max(999).optional(),
  userId: z.coerce.bigint().optional(),
  fresh: z.literal('1').optional(),
});

// نفس كاش تاب التحليلات (60 ثانية) — بريفكس مختلف عشان مايتصادمش مع كاش analytics.routes
const cache = new Map<string, { at: number; body: unknown }>();
const TTL_MS = 60_000;
function cached<T>(key: string, build: () => Promise<T>, fresh?: boolean): Promise<T> {
  if (fresh) cache.delete(key);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.body as T);
  return build().then((body) => {
    if (cache.size > 300) cache.clear();
    cache.set(key, { at: Date.now(), body });
    return body;
  });
}

// مين أقدر أشوفه — بتملّي قوايم الفلترة في الواجهة (كل المهندسين دايمًا هنا)
laborAnalyticsRoutes.get(
  '/scope',
  asyncHandler(async (_req: Request, res: Response) => {
    const scope = await resolveAllScope();
    res.json({
      success: true,
      data: {
        level: scope.level,
        engineers: scope.visible,
        sites: [...new Set(scope.visible.map((u) => u.site))].sort(),
      },
    });
  }),
);

// تقرير مقاولين العمالة — قبل (سركي معلّق) / بعد (أيام معتمدة فعليًا) لكل مقاول عمالة، لكل المهندسين
laborAnalyticsRoutes.get(
  '/',
  validate({ query: filterQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof filterQuery>;
    const scope = await resolveAllScope({ site: q.site, userId: q.userId });
    const key = `labor-all|${q.from ?? ''}|${q.to ?? ''}|${q.site ?? ''}|${q.userId ?? ''}`;
    const report = await cached(key, () => laborReport(scope.ids, { from: q.from, to: q.to }), q.fresh === '1');
    res.json({ success: true, level: scope.level, data: report });
  }),
);
