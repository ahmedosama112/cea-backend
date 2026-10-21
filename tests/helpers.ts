import request from 'supertest';
import { app } from '../src/app';
import { prisma } from '../src/config/prisma';

export { app, prisma, request };

// مسح كل الجداول بين المجموعات — DELETE وليس TRUNCATE:
// TRUNCATE بيعيد إنشاء ملفات InnoDB (~1.2 ثانية/جدول على ويندوز) فبيعدّي مهلة الـ hooks،
// بينما DELETE على جداول شبه فاضية بالمللي ثانية
export async function resetDb() {
  // 🛡 حماية: الاختبارات بتتشغل بـ `npm test` (اللي بيوجّه DATABASE_URL لقاعدة cea_test).
  // تشغيل vitest مباشرة بيستخدم قاعدة التطوير → resetDb كانت بتمسحها (حصل فعلًا 3 سبتمبر 2026).
  const url = process.env.DATABASE_URL || '';
  if (!/\/cea_test(\?|$)/.test(url)) {
    throw new Error(`resetDb مرفوض: DATABASE_URL مش قاعدة الاختبار (cea_test) — شغّل الاختبارات بـ "npm test" مش vitest مباشرة. (${url.replace(/\/\/.*@/, '//***@')})`);
  }
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
  const tables = [
    'correction_events', 'correction_links', 'correction_drafts', 'correction_tasks',
    'submission_comments', 'submission_labor_days', 'record_deductions', 'records', 'ir_records', 'todos',
    'exec_record_stages', 'exec_records', 'item_stages', 'items',
    'daily_records', 'equipment_records', 'contractors', 'places', 'inspectors',
    'purchase_requests', 'stock_moves', 'issue_request_lines', 'issue_requests', 'inventory_items',
    'submission_row_edits', 'submission_row_rejections', 'submission_reviews', 'submission_revisions', 'submissions', 'app_config',
    'notification_reads', 'notification_targets', 'notifications',
    'rent_request_reviews', 'rent_requests',
    'user_projects', 'projects',
    'account_settings', 'files', 'refresh_tokens', 'password_reset_tokens', 'users',
  ];
  for (const t of tables) await prisma.$executeRawUnsafe(`DELETE FROM \`${t}\``);
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
  // المشروعين 1 و2 بيتزرعوا بالـmigration في الإنتاج — قاعدة الاختبار بتتبني بـ db push فلازم نزرعهم هنا
  // (المشروع 1 هو الافتراضي لأي مكان/كشف من غير مشروع)
  await prisma.project.createMany({ data: [{ id: 1, name: 'كومباوند جريني' }, { id: 2, name: 'أزاليا' }] });
}

export interface TestUser {
  token: string;
  refreshToken: string;
  id: string;
  email: string;
}

// أول تسجيل في قاعدة فاضية = ADMIN (bootstrap)
export async function createAdmin(email = 'admin@test.com', password = 'password123'): Promise<TestUser> {
  const res = await request(app).post('/api/auth/register').send({ email, password });
  if (res.status !== 201) throw new Error('createAdmin failed: ' + JSON.stringify(res.body));
  return { token: res.body.data.accessToken, refreshToken: res.body.data.refreshToken, id: res.body.data.user.id, email };
}

export async function createEngineer(adminToken: string, email = 'eng@test.com', password = 'password123'): Promise<TestUser> {
  const res = await request(app)
    .post('/api/auth/register')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email, password });
  if (res.status !== 201) throw new Error('createEngineer failed: ' + JSON.stringify(res.body));
  return { token: res.body.data.accessToken, refreshToken: res.body.data.refreshToken, id: res.body.data.user.id, email };
}

export function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}
