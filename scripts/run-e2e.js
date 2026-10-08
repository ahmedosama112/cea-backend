/* eslint-disable no-console */
// يشغّل اختبارات e2e (tester-army/e2e) على سيرفر حقيقي وقاعدة منفصلة (cea_e2e) — لا يلمس cea أو cea_test:
// 1) prisma db push --force-reset على cea_e2e  2) زرع المشروعين  3) تشغيل السيرفر على E2E_PORT
// 4) تسجيل أول أدمن  5) e2e run بنفس الـ env  6) إيقاف السيرفر
// أي arguments إضافية بتتمرر لـ `e2e run` (مثلاً: npm run test:e2e -- e2e/auth.e2e.ts)
const { execSync, spawn, spawnSync } = require('child_process');
const path = require('path');

require('dotenv').config();

// e2e نفسه محتاج Node 22.22.3+ أو 24.8+ — السيرفر شغال على أي إصدار، فالفحص هنا بس عشان رسالة واضحة
const [major, minor, patch] = process.versions.node.split('.').map(Number);
const nodeOk = major > 24 || (major === 24 && minor >= 8) || (major === 22 && (minor > 22 || (minor === 22 && patch >= 3)));
if (!nodeOk) {
  console.error(`اختبارات e2e محتاجة Node.js 22.22.3+ أو 24.8+ (الحالي ${process.versions.node})`);
  process.exit(1);
}

const E2E_DB_URL = process.env.E2E_DATABASE_URL;
if (!E2E_DB_URL) {
  console.error('E2E_DATABASE_URL غير محدد — أضفه في .env (قاعدة منفصلة، مثلاً cea_e2e)');
  process.exit(1);
}
// 🛡 القاعدة دي بتتمسح بالكامل مع كل تشغيل — ممنوع تكون قاعدة التطوير أو قاعدة vitest
if (E2E_DB_URL === process.env.DATABASE_URL || E2E_DB_URL === process.env.TEST_DATABASE_URL) {
  console.error('E2E_DATABASE_URL مطابق لـ DATABASE_URL أو TEST_DATABASE_URL — الاختبارات بتمسح القاعدة، فالتشغيل مرفوض');
  process.exit(1);
}

const PORT = process.env.E2E_PORT || '4100';
const APP_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = 'e2e-admin@test.com';
const ADMIN_PASSWORD = 'e2e-password-123';

const serverEnv = {
  ...process.env,
  DATABASE_URL: E2E_DB_URL,
  PORT,
  NODE_ENV: 'test',
  JWT_ACCESS_SECRET: 'e2e-access-secret',
  JWT_REFRESH_SECRET: 'e2e-refresh-secret',
  AUTH_RATE_LIMIT_MAX: '10000',
  RATE_LIMIT_MAX: '100000',
  UPLOAD_DIR: path.join('.e2e', 'uploads'),
  // الربط مع Google Sheet مقفول في e2e — مفيش طلبات بتطلع برّه
  GOOGLE_WEBAPP_URL: '',
  GOOGLE_WEBAPP_SECRET: '',
  GOOGLE_WEBAPP_URL_2: '',
  GOOGLE_WEBAPP_SECRET_2: '',
};

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${APP_URL}/health`);
      if (res.ok) return;
    } catch {
      // السيرفر لسه بيقوم
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`السيرفر ما ردّش على ${APP_URL}/health خلال ${timeoutMs / 1000} ثانية`);
}

async function main() {
  console.log('> resetting e2e database schema (cea_e2e)');
  try {
    execSync('npx prisma db push --force-reset --skip-generate --accept-data-loss', { stdio: 'inherit', env: serverEnv });
  } catch {
    // prisma طبع السبب فوق — هنا بس رسالة واضحة بدل stack trace
    console.error('\nفشل تجهيز قاعدة e2e — اتأكد إن MySQL شغال وإن E2E_DATABASE_URL في .env صح');
    process.exit(1);
  }

  // المشروعين 1 و2 بيتزرعوا بالـmigration في الإنتاج — db push ما بيزرعهمش (نفس tests/helpers.ts)
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasourceUrl: E2E_DB_URL });
  await prisma.project.createMany({ data: [{ id: 1, name: 'كومباوند جريني' }, { id: 2, name: 'أزاليا' }] });
  await prisma.$disconnect();

  console.log(`> starting API on ${APP_URL}`);
  const server = spawn(process.execPath, [require.resolve('ts-node/dist/bin.js'), '--transpile-only', 'src/server.ts'], {
    env: serverEnv,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const stop = () => {
    if (server.exitCode === null) server.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let code = 1;
  try {
    await waitForHealth(60_000);

    // أول تسجيل في قاعدة فاضية = ADMIN — بيتعمل هنا مرة واحدة والاختبارات بتعمل login بيه
    const reg = await fetch(`${APP_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    if (reg.status !== 201) throw new Error(`تسجيل أدمن e2e فشل: ${reg.status} ${await reg.text()}`);

    console.log('> running e2e');
    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'node_modules', 'e2e', 'dist', 'cli', 'bin.js'), 'run', ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, APP_URL, E2E_ADMIN_EMAIL: ADMIN_EMAIL, E2E_ADMIN_PASSWORD: ADMIN_PASSWORD },
    });
    code = run.status ?? 1;
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
  } finally {
    stop();
  }
  process.exit(code);
}

main();
