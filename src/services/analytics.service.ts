import { prisma } from '../config/prisma';
import { AuthUser } from '../middlewares/auth';
import { APPROVING_GRADES } from './approvalChain';
import { ENUM_TO_AR } from '../utils/rateType';

// ═══════════ تحليلات الأماكن والمقاولين (للمديرين) ═══════════
// ليه التجميع عبر الحسابات بيطلع صح: الأماكن **والمقاولين** الاتنين بيانات مرجعية
// يديرها الأدمن وحده — `writeRoles: ['ADMIN']` على الراوترين (entities.routes.ts)
// و`pushContractorsIfAdmin`/`pushPlacesIfAdmin` في الواجهة، والأدمن بينسخهم لحسابات
// المهندسين نصًّا حرفيًا (`/users/:id/{places,contractors}/copy-mine`). فالاسم واحد
// عند الجميع. (`@@unique([userId,name])` هنا تخزين لكل حساب لنفس القائمة، مش قوائم مختلفة.)
//
// التحفّظ الوحيد: `records.contractorName/placeName` نسخة نصية وقت التسجيل، فلو اسم
// اتغيّر أو اتحذف بعدها، السجلات القديمة بتفضل بالاسم القديم — عشان كده صف المقاول
// بيرجع `inList` (هل الاسم لسه في قائمة الأدمن؟) بدل ما نخفي الفرق.
//
// كل الأرقام بتتحسب في السيرفر (localStorage عند المهندس فيه سجلاته هو بس)،
// وبترجع مجمّعة — ولا صف خام واحد بيسيب القاعدة.

// ── توحيد الاسم: الفرق بين "أ" و"ا"، أو مسافتين، مايعملش صفّين ──
export function normName(s: string): string {
  return (s || '')
    .replace(/[ً-ٰٟـ]/g, '') // تشكيل + تطويل
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ؤئ]/g, 'ء')
    .replace(/[^\p{L}\p{N}]+/gu, ' ') // أي فاصل (مسافة/شرطة/نقطة) → مسافة واحدة
    .trim()
    .toLowerCase();
}

const NO_PLACE = '(بدون مكان)';

export interface ScopeUser {
  id: string;
  email: string;
  title: string | null;
  grade: string;
  site: number;
}

export interface AnalyticsScope {
  // الحسابات اللي بيتحسب عليها فعلًا (بعد فلتر الموقع/المهندس)
  ids: bigint[];
  // كل الحسابات اللي المستخدم مسموح له يشوفها (لملء قوائم الفلترة)
  visible: ScopeUser[];
  // نطاق الرؤية: كل النظام (أدمن) / الفريق المسند (معتمد) / حسابه هو بس
  level: 'all' | 'team' | 'self';
}

// مين بيشوف مين: الأدمن الكل · المعتمد اللي مسندين له (بأي مستوى) + نفسه · أي حساب تاني نفسه بس.
// الفرض ده على السيرفر — مش إخفاء أزرار في الواجهة.
export async function resolveScope(
  me: AuthUser,
  opts: { site?: number; userId?: bigint } = {},
): Promise<AnalyticsScope> {
  const meRow = await prisma.user.findUnique({ where: { id: me.id }, select: { grade: true } });
  const isAdmin = me.role === 'ADMIN';
  const isApprover = !!meRow && (APPROVING_GRADES as readonly string[]).includes(meRow.grade);
  const level: AnalyticsScope['level'] = isAdmin ? 'all' : isApprover ? 'team' : 'self';

  const where = isAdmin
    ? {}
    : isApprover
      ? { OR: [{ approverTlId: me.id }, { approverCmId: me.id }, { approverPmId: me.id }, { id: me.id }] }
      : { id: me.id };

  const rows = await prisma.user.findMany({
    where,
    select: { id: true, email: true, title: true, grade: true, site: true },
    orderBy: { email: 'asc' },
  });

  const visible: ScopeUser[] = rows.map((u) => ({
    id: u.id.toString(),
    email: u.email,
    title: u.title,
    grade: u.grade,
    site: u.site,
  }));

  let ids = rows.map((u) => u.id);
  if (opts.site) ids = rows.filter((u) => u.site === opts.site).map((u) => u.id);
  if (opts.userId != null) {
    const wanted = opts.userId;
    ids = ids.filter((id) => id === wanted); // مهندس مش في نطاقي = نتيجة فاضية، مش تسريب
  }
  return { ids, visible, level };
}

// ── نتيجة صف المكان ──
export interface PlaceRow {
  key: string;
  name: string;
  variants: string[]; // كتابات مختلفة لنفس المكان (لو أكتر من واحدة = حد كتبه بإيده)
  records: number;
  gross: number; // قبل الخصم
  discount: number;
  total: number; // المنصرف فعلًا
  contractors: number;
  engineers: number;
  days: number;
  lastDate: string | null;
  ir: { total: number; a: number; b: number; c: number };
  execAvg: number | null;
  execCount: number;
  equipHours: number;
  equipRecords: number;
}

interface Acc extends PlaceRow {
  _spell: Map<string, number>;
  _contractors: Set<string>;
  _engineers: Set<string>;
  _days: Set<string>;
}

function blank(key: string): Acc {
  return {
    key,
    name: '',
    variants: [],
    records: 0,
    gross: 0,
    discount: 0,
    total: 0,
    contractors: 0,
    engineers: 0,
    days: 0,
    lastDate: null,
    ir: { total: 0, a: 0, b: 0, c: 0 },
    execAvg: null,
    execCount: 0,
    equipHours: 0,
    equipRecords: 0,
    _spell: new Map(),
    _contractors: new Set(),
    _engineers: new Set(),
    _days: new Set(),
  };
}

function bucketOf(map: Map<string, Acc>, raw: string): Acc {
  const label = (raw || '').trim() || NO_PLACE;
  const key = normName(label) || NO_PLACE;
  let b = map.get(key);
  if (!b) {
    b = blank(key);
    map.set(key, b);
  }
  b._spell.set(label, (b._spell.get(label) ?? 0) + 1);
  return b;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const ymd = (d: Date): string => d.toISOString().slice(0, 10);

export interface PlacesReport {
  from: string | null;
  to: string | null;
  engineers: number;
  totals: {
    places: number;
    records: number;
    gross: number;
    discount: number;
    total: number;
    discountPct: number;
    irTotal: number;
    equipHours: number;
  };
  rows: PlaceRow[];
}

export async function placesReport(ids: bigint[], range: { from?: string; to?: string }): Promise<PlacesReport> {
  if (!ids.length) {
    return {
      from: range.from ?? null,
      to: range.to ?? null,
      engineers: 0,
      totals: { places: 0, records: 0, gross: 0, discount: 0, total: 0, discountPct: 0, irTotal: 0, equipHours: 0 },
      rows: [],
    };
  }

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (range.from) dateFilter.gte = new Date(range.from + 'T00:00:00Z');
  if (range.to) dateFilter.lte = new Date(range.to + 'T00:00:00Z');
  const hasRange = Boolean(range.from || range.to);
  const whereBase = { userId: { in: ids }, ...(hasRange ? { date: dateFilter } : {}) };

  const [sums, byContractor, byEngineer, byDay, irRows, execRows, eqRows] = await Promise.all([
    prisma.record.groupBy({
      by: ['placeName'],
      where: whereBase,
      _count: { _all: true },
      _sum: { total: true, discount: true },
      _max: { date: true },
    }),
    prisma.record.groupBy({ by: ['placeName', 'contractorName'], where: whereBase, _count: { _all: true } }),
    prisma.record.groupBy({ by: ['placeName', 'userId'], where: whereBase, _count: { _all: true } }),
    prisma.record.groupBy({ by: ['placeName', 'date'], where: whereBase, _count: { _all: true } }),
    prisma.irRecord.groupBy({ by: ['place', 'status'], where: whereBase, _count: { _all: true } }),
    // الموقف التنفيذي مالوش تاريخ — بيتحسب على الوضع الحالي بغض النظر عن الفترة
    prisma.execRecord.groupBy({ by: ['place'], where: { userId: { in: ids } }, _avg: { pct: true }, _count: { _all: true } }),
    prisma.equipmentRecord.groupBy({ by: ['place'], where: whereBase, _sum: { minutes: true }, _count: { _all: true } }),
  ]);

  const map = new Map<string, Acc>();

  for (const r of sums) {
    const b = bucketOf(map, r.placeName);
    b.records += r._count._all;
    b.total += num(r._sum.total);
    b.discount += num(r._sum.discount);
    const last = r._max.date ? ymd(r._max.date) : null;
    if (last && (!b.lastDate || last > b.lastDate)) b.lastDate = last;
  }
  for (const r of byContractor) bucketOf(map, r.placeName)._contractors.add(r.contractorName);
  for (const r of byEngineer) bucketOf(map, r.placeName)._engineers.add(r.userId.toString());
  for (const r of byDay) bucketOf(map, r.placeName)._days.add(ymd(r.date));
  for (const r of irRows) {
    const b = bucketOf(map, r.place);
    const n = r._count._all;
    b.ir.total += n;
    if (r.status === 'A') b.ir.a += n;
    else if (r.status === 'B') b.ir.b += n;
    else if (r.status === 'C') b.ir.c += n;
  }
  for (const r of execRows) {
    const b = bucketOf(map, r.place);
    b.execCount += r._count._all;
    b.execAvg = num(r._avg.pct);
  }
  for (const r of eqRows) {
    const b = bucketOf(map, r.place);
    b.equipHours += num(r._sum.minutes) / 60;
    b.equipRecords += r._count._all;
  }

  const rows: PlaceRow[] = [...map.values()].map((b) => {
    // الاسم المعروض = الكتابة الأكتر استخدامًا؛ الباقي بيتعرض كتنبيه اختلاف كتابة
    const spellings = [...b._spell.entries()].sort((x, y) => y[1] - x[1]);
    const { _spell, _contractors, _engineers, _days, ...pub } = b;
    void _spell;
    return {
      ...pub,
      name: spellings[0]?.[0] ?? b.key,
      variants: spellings.map((s) => s[0]),
      gross: Math.round((b.total + b.discount) * 100) / 100,
      total: Math.round(b.total * 100) / 100,
      discount: Math.round(b.discount * 100) / 100,
      contractors: _contractors.size,
      engineers: _engineers.size,
      days: _days.size,
      execAvg: b.execAvg == null ? null : Math.round(b.execAvg * 10) / 10,
      equipHours: Math.round(b.equipHours * 10) / 10,
    };
  });
  rows.sort((a, b) => b.total - a.total || b.records - a.records);

  const t = rows.reduce(
    (a, r) => {
      a.records += r.records;
      a.gross += r.gross;
      a.discount += r.discount;
      a.total += r.total;
      a.irTotal += r.ir.total;
      a.equipHours += r.equipHours;
      return a;
    },
    { records: 0, gross: 0, discount: 0, total: 0, irTotal: 0, equipHours: 0 },
  );

  return {
    from: range.from ?? null,
    to: range.to ?? null,
    engineers: new Set(byEngineer.map((r) => r.userId.toString())).size,
    totals: {
      places: rows.length,
      records: t.records,
      gross: Math.round(t.gross * 100) / 100,
      discount: Math.round(t.discount * 100) / 100,
      total: Math.round(t.total * 100) / 100,
      discountPct: t.gross > 0 ? Math.round((t.discount / t.gross) * 1000) / 10 : 0,
      irTotal: t.irTotal,
      equipHours: Math.round(t.equipHours * 10) / 10,
    },
    rows,
  };
}

// ── اتجاه المنصرف عبر الوقت (كله أو مكان واحد) — أسبوعي/شهري ──
export interface TrendPoint {
  bucket: string;
  total: number;
  records: number;
}

// بداية أسبوع السبت (أسبوع الشغل هنا سبت→جمعة، زي كشوف السراكي)
function weekStart(d: Date): string {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 1) % 7));
  return ymd(x);
}

export async function trendSeries(
  ids: bigint[],
  range: { from?: string; to?: string },
  opts: { place?: string; contractor?: string; bucket: 'week' | 'month' },
): Promise<TrendPoint[]> {
  if (!ids.length) return [];
  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (range.from) dateFilter.gte = new Date(range.from + 'T00:00:00Z');
  if (range.to) dateFilter.lte = new Date(range.to + 'T00:00:00Z');
  const hasRange = Boolean(range.from || range.to);
  const where = { userId: { in: ids }, ...(hasRange ? { date: dateFilter } : {}) };
  const agg = { _sum: { total: true }, _count: { _all: true } } as const;

  // بنجمّع على البُعد المطلوب بس — إضافة العمودين مع بعض بتكبّر عدد الصفوف بلا داعي
  const rows = opts.contractor
    ? await prisma.record.groupBy({ by: ['date', 'contractorName'], where, ...agg })
    : await prisma.record.groupBy({ by: ['date', 'placeName'], where, ...agg });

  const wanted = opts.contractor ? normName(opts.contractor) : opts.place ? normName(opts.place) : null;
  const acc = new Map<string, TrendPoint>();
  for (const r of rows) {
    const own = 'contractorName' in r ? r.contractorName : r.placeName;
    if (wanted && normName(own) !== wanted) continue;
    const key = opts.bucket === 'month' ? ymd(r.date).slice(0, 7) : weekStart(r.date);
    let p = acc.get(key);
    if (!p) {
      p = { bucket: key, total: 0, records: 0 };
      acc.set(key, p);
    }
    p.total += num(r._sum.total);
    p.records += r._count._all;
  }
  return [...acc.values()]
    .map((p) => ({ ...p, total: Math.round(p.total * 100) / 100 }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
}

// ═══════════ تقرير المقاولين ═══════════
// نفس فكرة تقرير الأماكن، بفروق حقيقية:
//  - IR والموقف التنفيذي مالهمش عمود مقاول في الـ schema → مش موجودين هنا.
//  - بدل "عدد المقاولين" بنعد "عدد الأماكن" اللي المقاول اشتغل فيها.
//  - قائمة الأدمن بتُستخدم كمعجم: بتدي التخصص والفئة المتفق عليها، وبتقول إذا كان
//    الاسم اللي في السجل لسه موجود في القائمة (inList) — الاسم القديم بيفضل في
//    السجلات القديمة لو المقاول اتغيّر اسمه أو اتحذف.

const NO_CONTRACTOR = '(بدون مقاول)';

export interface ContractorDictEntry {
  spec: string | null;
  rate: number | null;
  rateType: string | null;
}

// معجم المقاولين = قائمة حسابات الأدمن (هي المصدر الوحيد — الكتابة محصورة على ADMIN)
async function contractorDict(): Promise<Map<string, ContractorDictEntry & { name: string }>> {
  const rows = await prisma.contractor.findMany({
    where: { user: { role: 'ADMIN' } },
    select: { name: true, spec: true, rate: true, rateType: true },
    orderBy: { name: 'asc' },
  });
  const dict = new Map<string, ContractorDictEntry & { name: string }>();
  for (const r of rows) {
    const key = normName(r.name);
    if (!key || dict.has(key)) continue;
    // Prisma بترجع اسم الـ enum (DAILY) — الواجهة والـ API بيتكلموا عربي ('يومية') زي باقي المسارات
    dict.set(key, {
      name: r.name,
      spec: r.spec,
      rate: r.rate == null ? null : Number(r.rate),
      rateType: r.rateType ? (ENUM_TO_AR[r.rateType] ?? r.rateType) : null,
    });
  }
  return dict;
}

export interface ContractorRow {
  key: string;
  name: string;
  variants: string[];
  // الاسم لسه في قائمة المقاولين عند الأدمن؟ false = اسم قديم في سجلات قديمة (اتغيّر/اتحذف)
  inList: boolean;
  spec: string | null;
  rate: number | null;
  rateType: string | null;
  avgPrice: number | null; // متوسط السعر الفعلي في السجلات — للمقارنة بـ rate
  records: number;
  gross: number;
  discount: number;
  total: number;
  places: number;
  engineers: number;
  days: number;
  lastDate: string | null;
  equipHours: number;
  equipRecords: number;
}

interface CAcc extends ContractorRow {
  _spell: Map<string, number>;
  _places: Set<string>;
  _engineers: Set<string>;
  _days: Set<string>;
}

function cBlank(key: string): CAcc {
  return {
    key, name: '', variants: [], inList: false, spec: null, rate: null, rateType: null, avgPrice: null,
    records: 0, gross: 0, discount: 0, total: 0, places: 0, engineers: 0, days: 0, lastDate: null,
    equipHours: 0, equipRecords: 0,
    _spell: new Map(), _places: new Set(), _engineers: new Set(), _days: new Set(),
  };
}

function cBucket(map: Map<string, CAcc>, raw: string): CAcc {
  const label = (raw || '').trim() || NO_CONTRACTOR;
  const key = normName(label) || NO_CONTRACTOR;
  let b = map.get(key);
  if (!b) { b = cBlank(key); map.set(key, b); }
  b._spell.set(label, (b._spell.get(label) ?? 0) + 1);
  return b;
}

export interface ContractorsReport {
  from: string | null;
  to: string | null;
  engineers: number;
  totals: {
    contractors: number;
    unknown: number; // أسماء في السجلات مش في قائمة الأدمن
    records: number;
    gross: number;
    discount: number;
    total: number;
    discountPct: number;
    equipHours: number;
  };
  rows: ContractorRow[];
}

export async function contractorsReport(ids: bigint[], range: { from?: string; to?: string }): Promise<ContractorsReport> {
  const emptyTotals = { contractors: 0, unknown: 0, records: 0, gross: 0, discount: 0, total: 0, discountPct: 0, equipHours: 0 };
  if (!ids.length) return { from: range.from ?? null, to: range.to ?? null, engineers: 0, totals: emptyTotals, rows: [] };

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (range.from) dateFilter.gte = new Date(range.from + 'T00:00:00Z');
  if (range.to) dateFilter.lte = new Date(range.to + 'T00:00:00Z');
  const hasRange = Boolean(range.from || range.to);
  const whereBase = { userId: { in: ids }, ...(hasRange ? { date: dateFilter } : {}) };

  const [dict, sums, byPlace, byEngineer, byDay, eqRows] = await Promise.all([
    contractorDict(),
    prisma.record.groupBy({
      by: ['contractorName'],
      where: whereBase,
      _count: { _all: true },
      _sum: { total: true, discount: true },
      _avg: { price: true },
      _max: { date: true },
    }),
    prisma.record.groupBy({ by: ['contractorName', 'placeName'], where: whereBase, _count: { _all: true } }),
    prisma.record.groupBy({ by: ['contractorName', 'userId'], where: whereBase, _count: { _all: true } }),
    prisma.record.groupBy({ by: ['contractorName', 'date'], where: whereBase, _count: { _all: true } }),
    prisma.equipmentRecord.groupBy({ by: ['contractor'], where: whereBase, _sum: { minutes: true }, _count: { _all: true } }),
  ]);

  const map = new Map<string, CAcc>();
  for (const r of sums) {
    const b = cBucket(map, r.contractorName);
    b.records += r._count._all;
    b.total += num(r._sum.total);
    b.discount += num(r._sum.discount);
    b.avgPrice = num(r._avg.price);
    const last = r._max.date ? ymd(r._max.date) : null;
    if (last && (!b.lastDate || last > b.lastDate)) b.lastDate = last;
  }
  for (const r of byPlace) cBucket(map, r.contractorName)._places.add(r.placeName);
  for (const r of byEngineer) cBucket(map, r.contractorName)._engineers.add(r.userId.toString());
  for (const r of byDay) cBucket(map, r.contractorName)._days.add(ymd(r.date));
  for (const r of eqRows) {
    const b = cBucket(map, r.contractor);
    b.equipHours += num(r._sum.minutes) / 60;
    b.equipRecords += r._count._all;
  }

  const rows: ContractorRow[] = [...map.values()].map((b) => {
    const spellings = [...b._spell.entries()].sort((x, y) => y[1] - x[1]);
    const { _spell, _places, _engineers, _days, ...pub } = b;
    void _spell;
    const d = dict.get(b.key);
    return {
      ...pub,
      // الاسم من قائمة الأدمن لو موجود (الكتابة الرسمية)، وإلا الأكتر استخدامًا في السجلات
      name: d?.name ?? spellings[0]?.[0] ?? b.key,
      variants: spellings.map((s) => s[0]),
      inList: !!d,
      spec: d?.spec ?? null,
      rate: d?.rate ?? null,
      rateType: d?.rateType ?? null,
      avgPrice: b.avgPrice == null ? null : Math.round(b.avgPrice * 100) / 100,
      gross: Math.round((b.total + b.discount) * 100) / 100,
      total: Math.round(b.total * 100) / 100,
      discount: Math.round(b.discount * 100) / 100,
      places: _places.size,
      engineers: _engineers.size,
      days: _days.size,
      equipHours: Math.round(b.equipHours * 10) / 10,
    };
  });
  rows.sort((a, b) => b.total - a.total || b.records - a.records);

  const t = rows.reduce(
    (a, r) => {
      a.records += r.records; a.gross += r.gross; a.discount += r.discount;
      a.total += r.total; a.equipHours += r.equipHours;
      return a;
    },
    { records: 0, gross: 0, discount: 0, total: 0, equipHours: 0 },
  );

  return {
    from: range.from ?? null,
    to: range.to ?? null,
    engineers: new Set(byEngineer.map((r) => r.userId.toString())).size,
    totals: {
      contractors: rows.length,
      unknown: rows.filter((r) => !r.inList).length,
      records: t.records,
      gross: Math.round(t.gross * 100) / 100,
      discount: Math.round(t.discount * 100) / 100,
      total: Math.round(t.total * 100) / 100,
      discountPct: t.gross > 0 ? Math.round((t.discount / t.gross) * 1000) / 10 : 0,
      equipHours: Math.round(t.equipHours * 10) / 10,
    },
    rows,
  };
}
