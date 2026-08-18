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

console.log('> syncing test database schema (cea_test)');
execSync('npx prisma db push --skip-generate', { stdio: 'inherit', env });
console.log('> running vitest');
execSync('npx vitest run', { stdio: 'inherit', env });
