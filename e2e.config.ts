// اختبارات e2e (https://github.com/tester-army/e2e) — بتكلم الـ API الحقيقي عبر HTTP
// بدون متصفح وبدون موديل AI. شغّلها بـ `npm run test:e2e` (مش `npx e2e run` مباشرة):
// السكربت بيجهّز قاعدة cea_e2e ويشغّل السيرفر ويمرّر APP_URL وبيانات الأدمن للاختبارات.
import type { E2EConfig } from 'e2e';

export default {
  // target من غير engine = اختبارات HTTP فقط (fetch)
  targets: [{ name: 'api', platform: 'custom' }],
  tests: ['e2e/**/*.e2e.ts'],
  output: '.e2e',
  // كل الملفات بتشارك سيرفر وقاعدة واحدة — تشغيل تسلسلي لتجنب التداخل
  workers: 1,
} satisfies E2EConfig;
