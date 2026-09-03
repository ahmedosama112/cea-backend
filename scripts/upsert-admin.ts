/* eslint-disable no-console */
// أداة تطوير محلية فقط: إنشاء/تحديث حساب أدمن بباسورد معروف على القاعدة المحلية للتجربة.
// التشغيل: npx ts-node --transpile-only scripts/upsert-admin.ts <email> <password>
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/utils/password';

const prisma = new PrismaClient();
async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) { console.error('الاستخدام: upsert-admin.ts <email> <password>'); process.exit(1); }
  const passwordHash = await hashPassword(password);
  const u = await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: { passwordHash, role: 'ADMIN' },
    create: { email: email.toLowerCase(), passwordHash, role: 'ADMIN' },
  });
  console.log(`✅ أدمن جاهز: ${u.email} (id ${u.id})`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
