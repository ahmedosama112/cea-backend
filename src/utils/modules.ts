// الوحدات القابلة للتفعيل/الإخفاء لكل حساب — يحددها الأدمن من "إدارة الحسابات"
// المفتاح = اسم الوحدة في الواجهة، والمسارات = الـ API endpoints المحمية بيها
export const ALL_MODULES = ['records', 'ir', 'site_daily', 'site_exec', 'todo', 'summary'] as const;
export type ModuleKey = (typeof ALL_MODULES)[number];

// الافتراضي لحساب جديد (لو enabledModules = null): الوحدات الأساسية الجاهزة فقط
export const DEFAULT_MODULES: ModuleKey[] = ['records', 'todo', 'summary'];

export const MODULE_LABELS: Record<ModuleKey, string> = {
  records: 'السراكي (تسجيل + قائمة)',
  ir: 'طلبات الفحص (IR)',
  site_daily: 'التقرير اليومي',
  site_exec: 'الموقف التنفيذي',
  todo: 'المهام',
  summary: 'الملخص',
};

// أي مسار API تابع لأنهي وحدة (للحماية على السيرفر)
export const ROUTE_MODULE: Record<string, ModuleKey> = {
  '/records': 'records',
  '/ir-records': 'ir',
  '/daily-records': 'site_daily',
  '/exec-records': 'site_exec',
  '/todos': 'todo',
};

export function normalizeModules(input: unknown): ModuleKey[] {
  if (!Array.isArray(input)) return DEFAULT_MODULES;
  return ALL_MODULES.filter((m) => input.includes(m));
}
