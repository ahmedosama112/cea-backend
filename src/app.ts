import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { router } from './routes';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';

export const app = express();

app.disable('x-powered-by');
// خلف Railway/أي reverse proxy: بدون هذا السطر req.ip = عنوان الـ proxy، فكل المستخدمين
// يتشاركون حدًا واحدًا في rate limiting (20 محاولة فاشلة من أي شخص تقفل الدخول على الجميع)
app.set('trust proxy', 1);
app.use(helmet());
// CORS_ORIGIN="*" يسمح لأي أصل — مطلوب لأن التطبيق يعمل داخل Capacitor WebView
// (أصله capacitor://localhost أو http://localhost حسب النظام) وكذلك للتطوير المحلي.
// عند تقييد الأصول: ضع قائمة مفصولة بفواصل في CORS_ORIGIN وستُطبَّق حرفيًا.
const allowAnyOrigin = env.corsOrigins.includes('*');
app.use(
  cors({
    origin: allowAnyOrigin ? true : env.corsOrigins,
    credentials: !allowAnyOrigin, // credentials مع "*" ممنوع في المتصفحات — نستخدم Bearer tokens وليس cookies
  }),
);
app.use(express.json({ limit: '2mb' }));
// cookie-parser اتشال — النظام Bearer tokens بالكامل ومفيش أي استخدام للكوكيز
if (env.nodeEnv !== 'test') app.use(morgan(env.nodeEnv === 'development' ? 'dev' : 'combined'));

// حد عام لكل الـ API — يحمي من إغراق السيرفر بالطلبات حتى لو أحد ضرب الـ endpoints مباشرة
app.use(
  '/api',
  rateLimit({
    windowMs: env.rateLimitWindowMin * 60 * 1000,
    max: env.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// (M12) الفحص الصحي بيلمس قاعدة البيانات فعلًا — Railway ما يعتبرش السيرفر سليمًا والقاعدة واقعة
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ success: true, status: 'ok' });
  } catch {
    res.status(503).json({ success: false, status: 'db_unreachable' });
  }
});

app.use('/api', router);
// ملاحظة: ملفات uploads (صور تقارير يومية، توقيع) لا تُخدَّم statically — قد تحتوي بيانات حسّاسة،
// فتُسترجع فقط عبر GET /api/files/:id/content بعد التحقق من ownership، انظر controllers/files.controller.ts

app.use(notFoundHandler);
app.use(errorHandler);
