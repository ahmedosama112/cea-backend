/* eslint-disable no-console */
// يشغّل الاختبارات على قاعدة بيانات منفصلة (cea_test) — لا يلمس بيانات التطوير في cea أبدًا:
// 1) prisma db push على cea_test  2) vitest run بنفس الـ env
const { execSync } = require('child_process');

// رابط قاعدة الاختبار من TEST_DATABASE_URL في .env — لا توجد قيم افتراضية بكلمات سر هنا
require('dotenv').config();
const TEST_DB_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DB_URL) {
  console.error('TEST_DATABASE_URL غير محدد — أضفه في .env (قاعدة منفصلة عن DATABASE_URL، مثلاً cea_test)');
  process.exit(1);
}

const env = {
  ...process.env,
  DATABASE_URL: TEST_DB_URL,
  NODE_ENV: 'test',
  JWT_ACCESS_SECRET: 'test-access-secret',
  JWT_REFRESH_SECRET: 'test-refresh-secret',
  AUTH_RATE_LIMIT_MAX: '10000', // الاختبارات بتعمل طلبات auth كتير — الحد الفعلي بيتختبر لوحده لو لزم
  RATE_LIMIT_MAX: '100000',
};

// 🛡 قبل أي push بقبول فقدان بيانات: اتأكد إن قاعدة الاختبار مش هي قاعدة التطوير
if (TEST_DB_URL === process.env.DATABASE_URL) {
  console.error('TEST_DATABASE_URL مطابق لـ DATABASE_URL — الاختبارات بتمسح القاعدة، فالتشغيل مرفوض');
  process.exit(1);
}

// --accept-data-loss: قاعدة الاختبار بتتمسح مع كل تشغيل أصلًا (resetDb)، فتحذيرات فقدان
// البيانات هنا بلا معنى — من غير الفلاغ ده أي قيد فريد جديد بيوقف التشغيل كله
console.log('> syncing test database schema (cea_test)');
execSync('npx prisma db push --skip-generate --accept-data-loss', { stdio: 'inherit', env });
console.log('> running vitest');
execSync('npx vitest run', { stdio: 'inherit', env });
