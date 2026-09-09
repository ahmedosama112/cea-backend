// الوحدات (شاشات كاملة) + الكروت (أجزاء داخل الشاشات) القابلة للتفعيل/الإخفاء لكل حساب —
// يحددها الأدمن من "إدارة الحسابات". الواجهة فيها نسخة مطابقة من نفس القائمة (app.js: FEATURES).

// ── الوحدات: بتقفل الشاشة كلها + السيرفر يرفض مساراتها ──
export const ALL_MODULES = ['records', 'submissions', 'ir', 'site_daily', 'site_exec', 'todo', 'summary', 'inventory', 'approvals', 'equipment', 'analytics'] as const;
export type ModuleKey = (typeof ALL_MODULES)[number];
export const DEFAULT_MODULES: ModuleKey[] = ['records', 'submissions', 'todo', 'summary'];
export const MODULE_LABELS: Record<ModuleKey, string> = {
  records: 'السراكي (تسجيل + قائمة)',
  submissions: 'التسليمات (إرسال الكشوف للاعتماد)',
  ir: 'طلبات الفحص (IR)',
  site_daily: 'التقرير اليومي',
  site_exec: 'الموقف التنفيذي',
  todo: 'المهام',
  summary: 'الملخص',
  inventory: 'المخازن (مخزون + طلبات صرف وشراء)',
  approvals: 'اعتمادات المديرين (مراجعة واعتماد الكشوف)',
  equipment: 'سراكي معدات (شهري) — إيجار معدات 20→19',
  analytics: 'تحليلات المشروع (أماكن + مقاولين — للمديرين)',
};

// ── الكروت: إخفاء/إظهار أجزاء داخل الشاشات (واجهة فقط — البيانات لسه محمية بالوحدات) ──
// المفتاح = data-feature في الـ HTML. group = الشاشة اللي فيها الكارت (للعرض في الإدارة).
export const ALL_FEATURES = [
  // الرئيسية
  { key: 'home_stats', label: 'بطاقات الأرقام (اليوم/الأسبوع/المهام/الإنجاز)', group: 'الرئيسية' },
  { key: 'home_recent', label: 'آخر السجلات', group: 'الرئيسية' },
  { key: 'home_todos', label: 'مهام اليوم', group: 'الرئيسية' },
  // السراكي
  { key: 'records_export', label: 'تصدير Excel معتمد', group: 'السراكي' },
  { key: 'records_search', label: 'فلتر البحث', group: 'السراكي' },
  { key: 'records_sort', label: 'فلتر الترتيب', group: 'السراكي' },
  { key: 'records_export_chips', label: 'مقاولين وأماكن محددين للتصدير المعتمد', group: 'السراكي' },
  { key: 'records_statement', label: 'بيان أعمال المقاول (PDF غير رسمي)', group: 'السراكي' },
  // الاعتمادات — زرار Google Form لكل موقع (الاسم المعروض في الواجهة بيتبع أسماء المواقع من app_config)
  { key: 'gform_site1', label: 'زرار Google Form — الموقع الأول', group: 'الاعتمادات' },
  { key: 'gform_site2', label: 'زرار Google Form — الموقع الثاني', group: 'الاعتمادات' },
  // سراكي المعدات — كارت "إعدادات السركي الشهري" في تاب الإعدادات: بيظهر لمن عنده وحدة المعدات (في الافتراضي)، والأدمن يقدر يخفيه
  { key: 'equipment_settings', label: 'إعدادات السركي الشهري في تاب الإعدادات (المقاول الثابت + الموقع)', group: 'سراكي المعدات' },
  // الإعدادات
  { key: 'set_appearance', label: 'المظهر (الوضع الداكن)', group: 'الإعدادات' },
  { key: 'set_contractors', label: 'إدارة المقاولين', group: 'الإعدادات' },
  { key: 'set_places', label: 'إدارة أماكن الأعمال', group: 'الإعدادات' },
  { key: 'set_inspectors', label: 'إدارة الاستشاريين', group: 'الإعدادات' },
  { key: 'set_items', label: 'إدارة بنود المقايسة', group: 'الإعدادات' },
  { key: 'set_items_import', label: 'استيراد بنود من Excel', group: 'الإعدادات' },
  { key: 'set_records_import', label: 'استرداد السجلات من Excel', group: 'الإعدادات' },
  { key: 'set_backup', label: 'النسخة الاحتياطية', group: 'الإعدادات' },
  { key: 'set_account', label: 'الحساب', group: 'الإعدادات' },
  { key: 'set_pin', label: 'حماية PIN', group: 'الإعدادات' },
  { key: 'set_sync', label: 'مزامنة السجلات', group: 'الإعدادات' },
  { key: 'set_signature', label: 'توقيع المهندس', group: 'الإعدادات' },
  { key: 'set_danger', label: 'منطقة الخطر (حذف/تهيئة)', group: 'الإعدادات' },
] as const;
export type FeatureKey = (typeof ALL_FEATURES)[number]['key'];
const FEATURE_KEYS = ALL_FEATURES.map((f) => f.key) as FeatureKey[];
// الافتراضي: كل الكروت ظاهرة ماعدا الخطرة/الإدارية اللي المهندس مش محتاجها
export const DEFAULT_FEATURES: FeatureKey[] = FEATURE_KEYS.filter(
  (k) => !['set_danger', 'set_records_import', 'set_items_import', 'gform_site2'].includes(k),
);

// أي مسار API تابع لأنهي وحدة (للحماية على السيرفر)
export const ROUTE_MODULE: Record<string, ModuleKey> = {
  '/records': 'records',
  '/submissions': 'submissions',
  '/ir-records': 'ir',
  '/daily-records': 'site_daily',
  '/exec-records': 'site_exec',
  '/todos': 'todo',
  '/inventory': 'inventory',
  '/equipment-records': 'equipment',
  '/analytics': 'analytics',
};

export function normalizeModules(input: unknown): ModuleKey[] {
  if (!Array.isArray(input)) return DEFAULT_MODULES;
  return ALL_MODULES.filter((m) => input.includes(m));
}
export function normalizeFeatures(input: unknown): FeatureKey[] {
  if (!Array.isArray(input)) return DEFAULT_FEATURES;
  // قوايم قديمة بالمفتاح الموحّد 'records_filters' (قبل فصله لبحث/ترتيب/تصدير معتمد) — بنترجمها للمفاتيح الجديدة
  const list = input.includes('records_filters')
    ? [...input.filter((k) => k !== 'records_filters'), 'records_search', 'records_sort', 'records_export_chips']
    : input;
  return FEATURE_KEYS.filter((k) => list.includes(k));
}
