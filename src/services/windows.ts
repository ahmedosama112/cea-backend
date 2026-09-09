import { prisma } from '../config/prisma';

// ── نوافذ الإرسال والاعتماد (9 سبتمبر 2026) ──
// الإرسال والاعتماد متاحين في مواعيد أسبوعية بيحددها الأدمن (مثال: التلات 8ص → الأربع 5م).
// القفل الحقيقي هنا في السيرفر — إخفاء الزرار في الواجهة تحسين شكل مش حماية.
//
// ⚠ المنطقة الزمنية: السيرفر بيشتغل UTC ومصر UTC+2 شتاءً و UTC+3 صيفًا (التوقيت الصيفي رجع 2023،
// من آخر جمعة في أبريل لآخر جمعة في أكتوبر). لو حسبنا بفرق ثابت +2 النافذة هتزحلق ساعة كاملة كل صيف.
// عشان كده كل الحسابات بتعدّي على cairoParts() اللي بتستخدم Intl مع timeZone: 'Africa/Cairo' —
// بتعرف الصيفي بنفسها وبتتحدّث مع نظام التشغيل لو مصر غيّرت قرارها.

export const CAIRO_TZ = 'Africa/Cairo';
const WEEK_MINUTES = 7 * 24 * 60;
const DAY_NAMES_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export type WindowKind = 'submit' | 'approve';
const KEY: Record<WindowKind, string> = { submit: 'submitWindow', approve: 'approveWindow' };
const LABEL_AR: Record<WindowKind, string> = { submit: 'إرسال السراكي', approve: 'الاعتماد' };

/** طرف النافذة: يوم الأسبوع (0 = الأحد … 6 = السبت) + وقت بصيغة HH:MM بتوقيت القاهرة */
export interface WindowEdge { day: number; time: string }
export interface TimeWindow { from: WindowEdge; to: WindowEdge }
export interface WindowConfig {
  enabled: boolean;
  /** مصفوفة عشان لو احتجنا أكتر من نافذة في الأسبوع بعدين ما نغيّرش شكل التخزين */
  windows: TimeWindow[];
  /** فتح استثنائي مؤقت (ISO) — الأدمن بيضغط "افتح لحد كذا" من غير ما يلمس المواعيد الأساسية */
  openUntil: string | null;
}

const DEFAULTS: Record<WindowKind, WindowConfig> = {
  submit: { enabled: false, windows: [{ from: { day: 2, time: '08:00' }, to: { day: 3, time: '17:00' } }], openUntil: null },
  approve: { enabled: false, windows: [{ from: { day: 3, time: '08:00' }, to: { day: 4, time: '17:00' } }], openUntil: null },
};

// ── تحويل لحظة إلى يوم/وقت القاهرة ──
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: CAIRO_TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** يرجّع موضع اللحظة داخل الأسبوع بتوقيت القاهرة: يوم + دقايق من نص الليل + دقايق من بداية الأسبوع */
export function cairoParts(at: Date): { day: number; minutes: number; weekMinutes: number } {
  const parts = fmt.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = DOW[get('weekday')] ?? 0;
  // hour12:false بيطلّع 24 بدل 00 عند منتصف الليل في بعض إصدارات Node
  const hour = Number(get('hour')) % 24;
  const minutes = hour * 60 + Number(get('minute'));
  return { day, minutes, weekMinutes: day * 1440 + minutes };
}

function edgeMinutes(e: WindowEdge): number {
  const [h, m] = e.time.split(':').map(Number);
  return ((e.day % 7) + 7) % 7 * 1440 + (h || 0) * 60 + (m || 0);
}

/** هل اللحظة دي جوّه النافذة؟ بيتعامل مع النافذة اللي بتلفّ حوالين الأسبوع (مثلًا الخميس → الاتنين) */
function insideWindow(nowWeekMin: number, w: TimeWindow): boolean {
  const from = edgeMinutes(w.from), to = edgeMinutes(w.to);
  if (from === to) return true; // النافذة تغطي الأسبوع كله
  return from < to ? (nowWeekMin >= from && nowWeekMin < to) : (nowWeekMin >= from || nowWeekMin < to);
}

/**
 * أقرب لحظة (بعد `now`) توافق يوم/وقت معيّن بتوقيت القاهرة.
 * بنقرّب بالفرق في دقايق الأسبوع، وبعدين نصحّح مرتين — التصحيح ده هو اللي بيمسك
 * انزياح الساعة لو النافذة على الناحية التانية من تغيير التوقيت الصيفي.
 */
function nextInstantAt(now: Date, targetWeekMin: number): Date {
  // بنصفّر الثواني: الحدود دايمًا عند الدقيقة بالظبط (08:00:00)،
  // وإلا العدّاد في الواجهة بيزيد لحد 59 ثانية عشوائية حسب وقت الطلب.
  let candidate = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  for (let i = 0; i < 3; i++) {
    const cur = cairoParts(candidate).weekMinutes;
    let delta = targetWeekMin - cur;
    if (i === 0) {
      // أول قفزة دايمًا للأمام (المرة الجاية)
      delta = ((delta % WEEK_MINUTES) + WEEK_MINUTES) % WEEK_MINUTES;
      if (delta === 0) delta = WEEK_MINUTES;
    } else {
      // التصحيح: أقصر مسافة، عشان ما نقفزش أسبوع كامل بسبب ساعة واحدة
      delta = ((delta + WEEK_MINUTES / 2) % WEEK_MINUTES + WEEK_MINUTES) % WEEK_MINUTES - WEEK_MINUTES / 2;
      if (delta === 0) break;
    }
    candidate = new Date(candidate.getTime() + delta * 60_000);
  }
  return candidate;
}

export interface WindowState {
  kind: WindowKind;
  label: string;
  enabled: boolean;
  open: boolean;
  /** السبب لما تكون مقفولة — نص جاهز للعرض */
  reason: string;
  /** فتح استثنائي شغّال دلوقتي */
  overrideOpen: boolean;
  openUntil: string | null;
  /** اللحظة اللي هتقفل فيها (لو مفتوحة) أو هتفتح فيها (لو مقفولة) — ISO، أو null لو متعطّلة */
  nextChangeAt: string | null;
  nextChangeLabel: string;
  windows: TimeWindow[];
}

function edgeLabel(e: WindowEdge): string {
  return `${DAY_NAMES_AR[((e.day % 7) + 7) % 7]} ${e.time}`;
}

export function evaluate(kind: WindowKind, cfg: WindowConfig, now: Date): WindowState {
  const base: Omit<WindowState, 'open' | 'reason' | 'nextChangeAt' | 'nextChangeLabel' | 'overrideOpen'> = {
    kind, label: LABEL_AR[kind], enabled: cfg.enabled, openUntil: cfg.openUntil, windows: cfg.windows,
  };
  // متعطّلة = مفتوحة على طول (السلوك القديم قبل الميزة)
  if (!cfg.enabled || !cfg.windows.length) {
    return { ...base, open: true, overrideOpen: false, reason: '', nextChangeAt: null, nextChangeLabel: '' };
  }
  // فتح استثنائي شغّال؟
  const until = cfg.openUntil ? new Date(cfg.openUntil) : null;
  if (until && until.getTime() > now.getTime()) {
    return {
      ...base, open: true, overrideOpen: true,
      reason: '', nextChangeAt: until.toISOString(),
      nextChangeLabel: 'فتح استثنائي — بيقفل',
    };
  }

  const nowWeekMin = cairoParts(now).weekMinutes;
  const hit = cfg.windows.find((w) => insideWindow(nowWeekMin, w));
  if (hit) {
    const closeAt = nextInstantAt(now, edgeMinutes(hit.to));
    return {
      ...base, open: true, overrideOpen: false, reason: '',
      nextChangeAt: closeAt.toISOString(), nextChangeLabel: `بيقفل ${edgeLabel(hit.to)}`,
    };
  }
  // مقفولة: أقرب فتح من كل النوافذ
  const opens = cfg.windows.map((w) => ({ at: nextInstantAt(now, edgeMinutes(w.from)), edge: w.from }));
  opens.sort((a, b) => a.at.getTime() - b.at.getTime());
  const soonest = opens[0];
  return {
    ...base, open: false, overrideOpen: false,
    reason: `${LABEL_AR[kind]} مقفول دلوقتي — بيفتح ${edgeLabel(soonest.edge)}`,
    nextChangeAt: soonest.at.toISOString(), nextChangeLabel: `بيفتح ${edgeLabel(soonest.edge)}`,
  };
}

// ── قراءة/كتابة الإعداد ──
function sanitizeEdge(raw: unknown, fallback: WindowEdge): WindowEdge {
  const o = (raw ?? {}) as Record<string, unknown>;
  const day = Number(o.day);
  const time = String(o.time ?? '');
  const okDay = Number.isInteger(day) && day >= 0 && day <= 6;
  const okTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  return { day: okDay ? day : fallback.day, time: okTime ? time : fallback.time };
}

export function sanitizeConfig(raw: unknown, kind: WindowKind): WindowConfig {
  const d = DEFAULTS[kind];
  const o = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(o.windows) ? o.windows.slice(0, 7) : [];
  const windows = list.map((w) => {
    const ww = (w ?? {}) as Record<string, unknown>;
    return { from: sanitizeEdge(ww.from, d.windows[0].from), to: sanitizeEdge(ww.to, d.windows[0].to) };
  });
  let openUntil: string | null = null;
  if (typeof o.openUntil === 'string') {
    const t = new Date(o.openUntil);
    if (!Number.isNaN(t.getTime())) openUntil = t.toISOString();
  }
  return {
    enabled: Boolean(o.enabled),
    windows: windows.length ? windows : d.windows,
    openUntil,
  };
}

export async function readWindowConfig(kind: WindowKind): Promise<WindowConfig> {
  const row = await prisma.appConfig.findUnique({ where: { key: KEY[kind] } }).catch(() => null);
  if (!row) return DEFAULTS[kind];
  try {
    return sanitizeConfig(JSON.parse(row.value), kind);
  } catch {
    return DEFAULTS[kind];
  }
}

export async function writeWindowConfig(kind: WindowKind, raw: unknown): Promise<WindowConfig> {
  const clean = sanitizeConfig(raw, kind);
  const value = JSON.stringify(clean);
  await prisma.appConfig.upsert({ where: { key: KEY[kind] }, update: { value }, create: { key: KEY[kind], value } });
  return clean;
}

export async function windowState(kind: WindowKind, now: Date = new Date()): Promise<WindowState> {
  return evaluate(kind, await readWindowConfig(kind), now);
}

export async function allWindowStates(now: Date = new Date()): Promise<Record<WindowKind, WindowState>> {
  const [submit, approve] = await Promise.all([windowState('submit', now), windowState('approve', now)]);
  return { submit, approve };
}
