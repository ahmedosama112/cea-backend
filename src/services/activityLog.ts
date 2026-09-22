import { Request } from 'express';
import { prisma } from '../config/prisma';

// ═══════════ سجل نشاط الحسابات ═══════════
// الغرض: الأدمن يعرف سبب مشكلة دخول/مزامنة عند مهندس معيّن من كارت حسابه، من غير ما يفتح لوجات Railway
// (لوجات morgan مفيهاش هوية المستخدم — IP بس، فما كانش ينفع تربط خطأ بحساب).
// بيتكتب في الخلفية (fire-and-forget) — أي فشل هنا ما يأثرش على الطلب نفسه.

export type ActivityEvent = 'LOGIN_OK' | 'LOGIN_FAIL' | 'SYNC' | 'API_ERR';

const RETENTION_DAYS = 14;

// أول 160 حرف من الـ user agent — يكفي لتمييز موبايل/كمبيوتر ومتصفح
function deviceOf(req: Request): string | null {
  const ua = req.get('user-agent');
  if (!ua) return null;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(ua) ? '📱 ' : '💻 ';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'متصفح';
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'Mac' : '';
  return (mobile + browser + (os ? ' · ' + os : '')).slice(0, 160);
}

function ipOf(req: Request): string | null {
  // Express يحسب req.ip حسب trust proxy؛ قراءة أول X-Forwarded-For مباشرة تسمح بتزوير سجل التدقيق.
  return (req.ip || '').slice(0, 45) || null;
}

export function logActivity(
  req: Request,
  event: ActivityEvent,
  opts: { userId?: bigint | null; email?: string; detail?: string; status?: number; path?: string } = {},
): void {
  const email = (opts.email ?? req.user?.email ?? '').slice(0, 190);
  if (!email && !opts.userId) return;
  // ⚠ الدالة دي بتشتغل جوه مسار تسجيل الدخول ومعالج الأخطاء — ممنوع تمامًا ترمي.
  // (try/catch مش رفاهية: لو الـ Prisma client قديم ومفهوش الجدول، الاستدعاء بيرمي TypeError
  //  فورًا قبل ما يرجع Promise، والـ .catch مش بتمسكه — وده بيكسر الدخول نفسه.)
  try {
  prisma.activityLog
    .create({
      data: {
        userId: opts.userId ?? req.user?.id ?? null,
        email,
        event,
        detail: opts.detail?.slice(0, 300) ?? null,
        status: opts.status ?? null,
        path: (opts.path ?? req.originalUrl).split('?')[0].slice(0, 160),
        ip: ipOf(req),
        device: deviceOf(req),
      },
    })
    .catch(() => undefined);
  } catch { /* السجل مش مهم لدرجة تعطيل الطلب */ }
}

// تنظيف يومي — بدونه الجدول بينمو للأبد (كل 403 متكرر بيتسجل)
export function scheduleActivityCleanup(): void {
  const tick = async (): Promise<void> => {
    try {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
      const r = await prisma.activityLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
      if (r.count) console.log(`[activity-cleanup] حذف ${r.count} سطر أقدم من ${RETENTION_DAYS} يوم`);
    } catch (e) {
      console.error('[activity-cleanup]', (e as Error).message);
    }
  };
  setInterval(tick, 24 * 60 * 60 * 1000);
  setTimeout(tick, 120 * 1000);
}
