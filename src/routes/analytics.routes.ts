import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middlewares/validate';
import { ymdDate } from '../schema/entities.schema';
import { contractorsReport, placesReport, resolveScope, trendSeries } from '../services/analytics.service';

// ═══════════ تحليلات الأماكن والمقاولين — مسارات القراءة فقط ═══════════
// (authenticate + requireModule('analytics') مطبّقين في routes/index.ts)
// مفيش أي مسار كتابة هنا عن قصد: التاب ده بيقرأ ويجمّع بس.

export const analyticsRoutes = Router();

const filterQuery = z.object({
  from: ymdDate.optional(),
  to: ymdDate.optional(),
  site: z.coerce.number().int().min(1).max(2).optional(),
  userId: z.coerce.bigint().optional(),
  // زرار "🔄 تحديث" في الواجهة — يتخطى الكاش عشان ما يبقاش زرار مالوش لازمة لمدة دقيقة
  fresh: z.literal('1').optional(),
});

// كاش قصير: المدير بيقلّب على الفلاتر بسرعة، والتجميع بيعدّي على كل السجلات.
// 60 ثانية زي كاش حالات الشيت — مقبول لأرقام إدارية.
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

// مين أقدر أشوفه — بتملّي قوايم الفلترة في الواجهة
analyticsRoutes.get(
  '/scope',
  asyncHandler(async (req: Request, res: Response) => {
    const scope = await resolveScope(req.user!);
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

// جدول الأماكن + الأرقام الإجمالية
analyticsRoutes.get(
  '/places',
  validate({ query: filterQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof filterQuery>;
    const scope = await resolveScope(req.user!, { site: q.site, userId: q.userId });
    const key = `p|${req.user!.id}|${q.from ?? ''}|${q.to ?? ''}|${q.site ?? ''}|${q.userId ?? ''}`;
    const report = await cached(key, () => placesReport(scope.ids, { from: q.from, to: q.to }), q.fresh === '1');
    res.json({ success: true, level: scope.level, data: report });
  }),
);

// جدول المقاولين — المقاولون بيانات مرجعية يديرها الأدمن (writeRoles: ['ADMIN'])
// فالاسم واحد عند كل المهندسين والتجميع عبرهم صح، زي الأماكن بالظبط
analyticsRoutes.get(
  '/contractors',
  validate({ query: filterQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof filterQuery>;
    const scope = await resolveScope(req.user!, { site: q.site, userId: q.userId });
    const key = `c|${req.user!.id}|${q.from ?? ''}|${q.to ?? ''}|${q.site ?? ''}|${q.userId ?? ''}`;
    const report = await cached(key, () => contractorsReport(scope.ids, { from: q.from, to: q.to }), q.fresh === '1');
    res.json({ success: true, level: scope.level, data: report });
  }),
);

// اتجاه المنصرف عبر الوقت (الكل، أو مكان واحد، أو مقاول واحد)
analyticsRoutes.get(
  '/trend',
  validate({
    query: filterQuery.extend({
      place: z.string().trim().max(190).optional(),
      contractor: z.string().trim().max(190).optional(),
      bucket: z.enum(['week', 'month']).optional().default('week'),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof filterQuery> & { place?: string; contractor?: string; bucket: 'week' | 'month' };
    const scope = await resolveScope(req.user!, { site: q.site, userId: q.userId });
    const key = `t|${req.user!.id}|${q.from ?? ''}|${q.to ?? ''}|${q.site ?? ''}|${q.userId ?? ''}|${q.place ?? ''}|${q.contractor ?? ''}|${q.bucket}`;
    const data = await cached(
      key,
      () => trendSeries(scope.ids, { from: q.from, to: q.to }, { place: q.place, contractor: q.contractor, bucket: q.bucket }),
      q.fresh === '1',
    );
    res.json({ success: true, data });
  }),
);
