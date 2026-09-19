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
      ? {
          OR: [
            { approverTlId: me.id }, { approverCmId: me.id }, { approverPmId: me.id },
            { userProjects: { some: { OR: [{ approverTlId: me.id }, { approverCmId: me.id }, { approverPmId: me.id }] } } },
            { id: me.id },
          ],
        }
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

// نطاق "تحليل العمالة": مش زي resolveScope — أي حساب معاه وحدة labor_analytics بيشوف كل
// المهندسين بغض النظر عن الدرجة أو الإسناد (الأدمن هو اللي بيمنح الوحدة دي أصلًا، فمفيش تسريب).
export async function resolveAllScope(opts: { site?: number; userId?: bigint } = {}): Promise<AnalyticsScope> {
  const rows = await prisma.user.findMany({
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
    ids = ids.filter((id) => id === wanted);
  }
  return { ids, visible, level: 'all' };
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
  isLabor: boolean;
}

// معجم المقاولين = قائمة حسابات الأدمن (هي المصدر الوحيد — الكتابة محصورة على ADMIN)
async function contractorDict(): Promise<Map<string, ContractorDictEntry & { name: string }>> {
  const rows = await prisma.contractor.findMany({
    where: { user: { role: 'ADMIN' } },
    select: { name: true, spec: true, rate: true, rateType: true, isLabor: true },
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
      isLabor: r.isLabor,
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
  isLabor: boolean;
  avgPrice: number | null; // متوسط السعر الفعلي في السجلات — للمقارنة بـ rate
  records: number;
  gross: number;
  discount: number;
  total: number;
  places: number;
  engineers: number;
  days: number;
  dailyQty: number;
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
    key, name: '', variants: [], inList: false, spec: null, rate: null, rateType: null, isLabor: false, avgPrice: null,
    records: 0, gross: 0, discount: 0, total: 0, places: 0, engineers: 0, days: 0, dailyQty: 0, lastDate: null,
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
    dailyQty: number;
  };
  rows: ContractorRow[];
}

export async function contractorsReport(ids: bigint[], range: { from?: string; to?: string }): Promise<ContractorsReport> {
  const emptyTotals = { contractors: 0, unknown: 0, records: 0, gross: 0, discount: 0, total: 0, discountPct: 0, equipHours: 0, dailyQty: 0 };
  if (!ids.length) return { from: range.from ?? null, to: range.to ?? null, engineers: 0, totals: emptyTotals, rows: [] };

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (range.from) dateFilter.gte = new Date(range.from + 'T00:00:00Z');
  if (range.to) dateFilter.lte = new Date(range.to + 'T00:00:00Z');
  const hasRange = Boolean(range.from || range.to);
  const whereBase = { userId: { in: ids }, ...(hasRange ? { date: dateFilter } : {}) };

  const [dict, sums, byPlace, byEngineer, byDay, eqRows, dailyRows] = await Promise.all([
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
    prisma.record.groupBy({ by: ['contractorName'], where: { ...whereBase, qtyType: 'DAILY' }, _sum: { qty: true } }),
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
  // dailyQty = مجموع الكمية لسجلات "يومية" فقط، وده غير days (عدد التواريخ المختلفة)
  // ممكن المقاول ياخد 3 يوميات في نفس التاريخ فيبقى الرقمين مختلفين قصدًا
  for (const r of dailyRows) cBucket(map, r.contractorName).dailyQty += num(r._sum.qty);
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
      isLabor: d?.isLabor ?? false,
      avgPrice: b.avgPrice == null ? null : Math.round(b.avgPrice * 100) / 100,
      gross: Math.round((b.total + b.discount) * 100) / 100,
      total: Math.round(b.total * 100) / 100,
      discount: Math.round(b.discount * 100) / 100,
      places: _places.size,
      engineers: _engineers.size,
      days: _days.size,
      dailyQty: Math.round(b.dailyQty * 100) / 100,
      equipHours: Math.round(b.equipHours * 10) / 10,
    };
  });
  rows.sort((a, b) => b.total - a.total || b.records - a.records);

  const t = rows.reduce(
    (a, r) => {
      a.records += r.records; a.gross += r.gross; a.discount += r.discount;
      a.total += r.total; a.equipHours += r.equipHours; a.dailyQty += r.dailyQty;
      return a;
    },
    { records: 0, gross: 0, discount: 0, total: 0, equipHours: 0, dailyQty: 0 },
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
      dailyQty: Math.round(t.dailyQty * 100) / 100,
    },
    rows,
  };
}

// ═══════════ مصفوفة مقاول × مكان ═══════════
// كل خانة = شغل مقاول معيّن في مكان معيّن. استعلام واحد groupBy على العمودين،
// والباقي تجميع في الذاكرة.
//
// السقف مقصود: الجدول ده بيتعرض للبني آدم، ومصفوفة 60×40 مالهاش قيمة على شاشة.
// بناخد أعلى N مقاول وأعلى M مكان بالمنصرف، وبنقول صراحةً كام اتشال وبكام
// (hiddenContractors / hiddenPlaces / hiddenTotal) — مش بنخفي فرق من غير ما نقوله.

export interface MatrixAxis {
  key: string;
  name: string;
  total: number;
  records: number;
}
export interface MatrixCell {
  c: string; // مفتاح المقاول
  p: string; // مفتاح المكان
  total: number;
  records: number;
  lastDate: string | null;
}
export interface MatrixReport {
  from: string | null;
  to: string | null;
  contractors: MatrixAxis[];
  places: MatrixAxis[];
  cells: MatrixCell[];
  // أعلى الثنائيات بالاسم — للعرض على الموبايل حيث الشبكة العريضة مش عملية
  topPairs: Array<{ name: string; total: number; records: number }>;
  totals: {
    total: number;
    records: number;
    pairs: number; // عدد الثنائيات (مقاول+مكان) اللي فيها شغل فعلًا
    contractors: number;
    places: number;
    hiddenContractors: number;
    hiddenPlaces: number;
    hiddenTotal: number; // المنصرف اللي برّا الشبكة المعروضة
  };
}

// ═══════════ الإجمالي الفعلي ═══════════
// Submission.total بيتكتب مرة واحدة وقت الإرسال ومابيتحدّثش لو مدير شطب سطور بعدين — فبيفضل ممكن
// يبقى أعلى من اللي فعلًا اتبعت واعتمد. approvedTotal بيتحسب وقت الدفع لجوجل (بعد أي شطب)، فهو
// الرقم الصحيح؛ لكشوف قديمة قبل إضافة العمود ده approvedTotal فاضي فبنستخدم total كتقدير (estimated).
export interface ApprovedTotalsRow {
  key: string;
  label: string;
  submissions: number;
  total: number;
  estimated: number;
}
export interface ApprovedTotalsReport {
  from: string | null;
  to: string | null;
  bucket: 'week' | 'month' | 'year';
  totals: { submissions: number; total: number; estimated: number };
  rows: ApprovedTotalsRow[];
}

export async function approvedTotalsReport(
  ids: bigint[],
  range: { from?: string; to?: string },
  bucket: 'week' | 'month' | 'year',
): Promise<ApprovedTotalsReport> {
  const empty: ApprovedTotalsReport = {
    from: range.from ?? null,
    to: range.to ?? null,
    bucket,
    totals: { submissions: 0, total: 0, estimated: 0 },
    rows: [],
  };
  if (!ids.length) return empty;

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (range.from) dateFilter.gte = new Date(range.from + 'T00:00:00Z');
  if (range.to) dateFilter.lte = new Date(range.to + 'T00:00:00Z');
  const hasRange = Boolean(range.from || range.to);

  // ⚠ reviewState='SENT' **مش** معناها معتمد: لو المهندس مالوش معتمدين مسندين، startChain بتحطها
  // SENT وتبعت لجوجل من غير أي اعتماد (كل الكشوف القديمة قبل تفعيل السلسلة كده). فالفلتر هنا على
  // قرار اعتماد **فعلي مسجّل** من مدير المشروع — ده تعريف صاحب المشروع للاعتماد، والـDC مش شرط.
  const PM_LEVEL = 'project manager';
  const subs = await prisma.submission.findMany({
    where: {
      userId: { in: ids },
      kind: 'labor', // إجمالي المعدات ساعات مش فلوس — مزجه هنا مايبقاش له معنى
      ...(hasRange ? { weekStart: dateFilter } : {}),
      reviews: { some: { level: PM_LEVEL, decision: { in: ['APPROVED', 'APPROVED_NOTES'] } } },
    },
    select: {
      weekStart: true, total: true, approvedTotal: true, revision: true,
      reviews: { where: { level: PM_LEVEL, decision: { in: ['APPROVED', 'APPROVED_NOTES'] } }, select: { revision: true } },
    },
  });

  const keyOf = (d: Date): string => {
    if (bucket === 'week') return ymd(d);
    if (bucket === 'month') return ymd(d).slice(0, 7);
    return ymd(d).slice(0, 4);
  };

  const acc = new Map<string, ApprovedTotalsRow>();
  for (const s of subs) {
    // الاعتماد لازم يكون للنسخة الحالية: كشف اتعتمد ثم اترفض واتبعت نسخة جديدة لسه ما اتعتمدتش
    // عنده اعتماد قديم بـrevision أقدم — ده مايتحسبش
    if (!s.reviews.some((rv) => rv.revision === s.revision)) continue;
    const key = keyOf(s.weekStart);
    let r = acc.get(key);
    if (!r) {
      r = { key, label: key, submissions: 0, total: 0, estimated: 0 };
      acc.set(key, r);
    }
    r.submissions += 1;
    r.total += num(s.approvedTotal ?? s.total);
    if (s.approvedTotal == null) r.estimated += 1;
  }

  const rows = [...acc.values()]
    .map((r) => ({ ...r, total: Math.round(r.total * 100) / 100 }))
    .sort((a, b) => b.key.localeCompare(a.key));

  const t = rows.reduce(
    (a, r) => {
      a.submissions += r.submissions;
      a.total += r.total;
      a.estimated += r.estimated;
      return a;
    },
    { submissions: 0, total: 0, estimated: 0 },
  );

  return {
    from: range.from ?? null,
    to: range.to ?? null,
    bucket,
    totals: { submissions: t.submissions, total: Math.round(t.total * 100) / 100, estimated: t.estimated },
    rows,
  };
}

// ═══════════ تقرير مقاولين العمالة ═══════════
// قبل/بعد لكل مقاول عمالة (Contractor.isLabor): "قبل" = أيام السركي اليومية اللي لسه معلّقة
// (done=false، لسه ما اتبعتش في كشف)، و"بعد" = أيام SubmissionLaborDays اللي فعلًا اتعتمدت ووصلت
// جوجل شيت. الفرق بينهم بيوضّح إيه اللي لسه معلّق مقابل إيه اللي فعلًا اتحاسب عليه.
export interface LaborEngineerRow {
  userId: string;
  name: string;
  before: number;
  after: number;
  diff: number;
  // عدد كشوف العمالة القديمة (قبل الميزة دي) اللي لسه مالهاش صفوف SubmissionLaborDays — أيامها مش محسوبة هنا
  pendingSubs: number;
}
export interface LaborContractorRow {
  name: string;
  before: number;
  after: number;
  diff: number;
  engineers: LaborEngineerRow[];
}
export interface LaborReport {
  from: string | null;
  to: string | null;
  contractors: LaborContractorRow[];
  totals: { before: number; after: number; diff: number; estimated: number };
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

export async function laborReport(ids: bigint[], range: { from?: string; to?: string }): Promise<LaborReport> {
  const empty: LaborReport = { from: range.from ?? null, to: range.to ?? null, contractors: [], totals: { before: 0, after: 0, diff: 0, estimated: 0 } };
  if (!ids.length) return empty;

  const dict = await contractorDict();
  const laborEntries = [...dict.values()].filter((d) => d.isLabor);
  if (!laborEntries.length) return empty;
  const laborKeys = new Set(laborEntries.map((d) => normName(d.name)));
  const laborDisplay = new Map(laborEntries.map((d) => [normName(d.name), d.name]));

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (range.from) dateFilter.gte = new Date(range.from + 'T00:00:00Z');
  if (range.to) dateFilter.lte = new Date(range.to + 'T00:00:00Z');
  const hasRange = Boolean(range.from || range.to);

  const [recordRows, users] = await Promise.all([
    // قبل: سجلات "يومية" لسه معلّقة (ما اتبعتش في كشف) لمقاولي العمالة بس
    prisma.record.findMany({
      where: { userId: { in: ids }, qtyType: 'DAILY', done: false, ...(hasRange ? { date: dateFilter } : {}) },
      select: { userId: true, contractorName: true, qty: true },
    }),
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, displayName: true } }),
  ]);

  // ⚠ نفس شرط approvedTotalsReport بالظبط: reviewState='SENT' وحدها مش كافية (كشوف قديمة بلا سلسلة
  // اعتماد بتتبعت SENT من غير اعتماد فعلي) — الاعتماد الحقيقي هو قرار مسجّل من مدير المشروع للنسخة الحالية
  const PM_LEVEL = 'project manager';
  const subs = await prisma.submission.findMany({
    where: {
      userId: { in: ids },
      kind: 'labor',
      ...(hasRange ? { weekStart: dateFilter } : {}),
      reviews: { some: { level: PM_LEVEL, decision: { in: ['APPROVED', 'APPROVED_NOTES'] } } },
    },
    select: {
      userId: true,
      revision: true,
      contractorName: true,
      reviews: { where: { level: PM_LEVEL, decision: { in: ['APPROVED', 'APPROVED_NOTES'] } }, select: { revision: true } },
      laborDays: { select: { contractorName: true, days: true } },
    },
  });
  const validSubs = subs.filter((s) => s.reviews.some((rv) => rv.revision === s.revision));

  const userName = new Map(users.map((u) => [u.id.toString(), u.displayName || u.email.split('@')[0]]));

  type EAcc = { before: number; after: number; pendingSubs: number };
  type CAcc = { before: number; after: number; engineers: Map<string, EAcc> };
  const acc = new Map<string, CAcc>();
  const cGet = (key: string): CAcc => {
    let a = acc.get(key);
    if (!a) { a = { before: 0, after: 0, engineers: new Map() }; acc.set(key, a); }
    return a;
  };
  const eGet = (c: CAcc, uid: string): EAcc => {
    let e = c.engineers.get(uid);
    if (!e) { e = { before: 0, after: 0, pendingSubs: 0 }; c.engineers.set(uid, e); }
    return e;
  };

  for (const r of recordRows) {
    const key = normName(r.contractorName);
    if (!laborKeys.has(key)) continue;
    const c = cGet(key);
    const e = eGet(c, r.userId.toString());
    const q = num(r.qty);
    c.before += q;
    e.before += q;
  }

  let estimated = 0;
  for (const s of validSubs) {
    // أسماء المقاولين المجمّعة في الكشف (كشوف قديمة قبل قاعدة "العمالة لوحدها" ممكن يبقى فيها أكتر من اسم)
    const names = s.contractorName.split(/،\s*/).map((n) => normName(n.trim())).filter(Boolean);
    const laborNamesInSub = names.filter((n) => laborKeys.has(n));
    if (!laborNamesInSub.length) continue;
    if (!s.laborDays.length) {
      // كشف قديم لسه ما اترجعش (backfill-labor-days.ts) — أيامه مش محسوبة في "بعد"، بنعدّه بس
      estimated++;
      for (const key of laborNamesInSub) {
        const c = cGet(key);
        const e = eGet(c, s.userId.toString());
        e.pendingSubs += 1;
      }
      continue;
    }
    for (const ld of s.laborDays) {
      const key = normName(ld.contractorName);
      if (!laborKeys.has(key)) continue;
      const c = cGet(key);
      const e = eGet(c, s.userId.toString());
      const d = num(ld.days);
      c.after += d;
      e.after += d;
    }
  }

  const contractors: LaborContractorRow[] = [...acc.entries()]
    .map(([key, c]) => {
      const engineers: LaborEngineerRow[] = [...c.engineers.entries()]
        .map(([uid, e]) => ({
          userId: uid,
          name: userName.get(uid) ?? uid,
          before: r2(e.before),
          after: r2(e.after),
          diff: r2(e.before - e.after),
          pendingSubs: e.pendingSubs,
        }))
        .sort((a, b) => b.before - a.before);
      return {
        name: laborDisplay.get(key) ?? key,
        before: r2(c.before),
        after: r2(c.after),
        diff: r2(c.before - c.after),
        engineers,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));

  const totals = contractors.reduce(
    (a, c) => { a.before += c.before; a.after += c.after; return a; },
    { before: 0, after: 0 },
  );

  return {
    from: range.from ?? null,
    to: range.to ?? null,
    contractors,
    totals: { before: r2(totals.before), after: r2(totals.after), diff: r2(totals.before - totals.after), estimated },
  };
}

export async function matrixReport(
  ids: bigint[],
  range: { from?: string; to?: string },
  limit = 15,
): Promise<MatrixReport> {
  const empty: MatrixReport = {
    from: range.from ?? null,
    to: range.to ?? null,
    contractors: [],
    places: [],
    cells: [],
    topPairs: [],
    totals: { total: 0, records: 0, pairs: 0, contractors: 0, places: 0, hiddenContractors: 0, hiddenPlaces: 0, hiddenTotal: 0 },
  };
  if (!ids.length) return empty;

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (range.from) dateFilter.gte = new Date(range.from + 'T00:00:00Z');
  if (range.to) dateFilter.lte = new Date(range.to + 'T00:00:00Z');
  const hasRange = Boolean(range.from || range.to);

  const [dict, rows] = await Promise.all([
    contractorDict(),
    prisma.record.groupBy({
      by: ['contractorName', 'placeName'],
      where: { userId: { in: ids }, ...(hasRange ? { date: dateFilter } : {}) },
      _sum: { total: true },
      _count: { _all: true },
      _max: { date: true },
    }),
  ]);

  // تجميع بالاسم الموحّد + تتبّع الكتابة الأكتر استخدامًا لكل محور
  const cAxis = new Map<string, MatrixAxis & { _spell: Map<string, number> }>();
  const pAxis = new Map<string, MatrixAxis & { _spell: Map<string, number> }>();
  const cells = new Map<string, MatrixCell>();
  const axis = (m: typeof cAxis, raw: string, fallback: string) => {
    const label = (raw || '').trim() || fallback;
    const key = normName(label) || fallback;
    let a = m.get(key);
    if (!a) { a = { key, name: '', total: 0, records: 0, _spell: new Map() }; m.set(key, a); }
    a._spell.set(label, (a._spell.get(label) ?? 0) + 1);
    return a;
  };

  let grandTotal = 0;
  let grandRecords = 0;
  for (const r of rows) {
    const total = num(r._sum.total);
    const n = r._count._all;
    const c = axis(cAxis, r.contractorName, NO_CONTRACTOR);
    const p = axis(pAxis, r.placeName, NO_PLACE);
    c.total += total; c.records += n;
    p.total += total; p.records += n;
    grandTotal += total; grandRecords += n;

    const ck = c.key + ' ' + p.key;
    let cell = cells.get(ck);
    if (!cell) { cell = { c: c.key, p: p.key, total: 0, records: 0, lastDate: null }; cells.set(ck, cell); }
    cell.total += total;
    cell.records += n;
    const last = r._max.date ? ymd(r._max.date) : null;
    if (last && (!cell.lastDate || last > cell.lastDate)) cell.lastDate = last;
  }

  const finish = (m: typeof cAxis, useDict: boolean): MatrixAxis[] =>
    [...m.values()]
      .map((a) => {
        const best = [...a._spell.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? a.key;
        return {
          key: a.key,
          name: (useDict ? dict.get(a.key)?.name : null) ?? best,
          total: Math.round(a.total * 100) / 100,
          records: a.records,
        };
      })
      .sort((a, b) => b.total - a.total);

  const allC = finish(cAxis, true);
  const allP = finish(pAxis, false);
  const topC = allC.slice(0, limit);
  const topP = allP.slice(0, limit);
  const keepC = new Set(topC.map((a) => a.key));
  const keepP = new Set(topP.map((a) => a.key));

  const shown = [...cells.values()].filter((x) => keepC.has(x.c) && keepP.has(x.p));
  const shownTotal = shown.reduce((s, x) => s + x.total, 0);

  const cName = new Map(allC.map((a) => [a.key, a.name]));
  const pName = new Map(allP.map((a) => [a.key, a.name]));
  const topPairs = [...cells.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)
    .map((x) => ({
      name: `${cName.get(x.c) ?? x.c} — ${pName.get(x.p) ?? x.p}`,
      total: Math.round(x.total * 100) / 100,
      records: x.records,
    }));

  return {
    from: range.from ?? null,
    to: range.to ?? null,
    contractors: topC,
    places: topP,
    cells: shown.map((x) => ({ ...x, total: Math.round(x.total * 100) / 100 })),
    topPairs,
    totals: {
      total: Math.round(grandTotal * 100) / 100,
      records: grandRecords,
      pairs: cells.size,
      contractors: allC.length,
      places: allP.length,
      hiddenContractors: Math.max(0, allC.length - topC.length),
      hiddenPlaces: Math.max(0, allP.length - topP.length),
      hiddenTotal: Math.round((grandTotal - shownTotal) * 100) / 100,
    },
  };
}
