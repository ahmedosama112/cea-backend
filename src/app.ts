import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { router } from './routes';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';

export const app = express();

app.disable('x-powered-by');
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
app.use(cookieParser());
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

app.get('/health', (_req, res) => res.json({ success: true, status: 'ok' }));

app.use('/api', router);
// ملاحظة: ملفات uploads (صور تقارير يومية، توقيع) لا تُخدَّم statically — قد تحتوي بيانات حسّاسة،
// فتُسترجع فقط عبر GET /api/files/:id/content بعد التحقق من ownership، انظر controllers/files.controller.ts

app.use(notFoundHandler);
app.use(errorHandler);
