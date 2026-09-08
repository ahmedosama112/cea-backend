/* eslint-disable no-console */
// تنبيهات جاهزة لحساب الأدمن (مستقبلين = "أنا بس") — الأدمن يقرر بعدين ينشر مين للناس.
//
// التشغيل (على قاعدة الإنتاج عبر Railway):
//   cd backend && railway run --service cea-backend npx ts-node --transpile-only scripts/seed-notifications.ts
// أو محليًا: npx ts-node --transpile-only scripts/seed-notifications.ts
//
// - آمن للتكرار (idempotent): بيتخطى أي تنبيه بنفس العنوان موجود بالفعل.
// - كلها audience='me' — مابتوصلش لأي حساب تاني لحد ما الأدمن يغيّر "مين يوصله" من التاب.
// - للحذف: من تاب "🔔 التنبيهات" في التطبيق (🗑 لكل تنبيه).

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// إيميل صاحب المشروع — لو مش موجود بناخد أول حساب أدمن
const OWNER_EMAIL = process.env.SEED_ADMIN_EMAIL || 'asepremong420@gmail.com';

type Seed = {
  title: string;
  body: string;
  icon: string;
  level: 'info' | 'warn' | 'urgent';
  schedule: 'daily' | 'weekly' | 'monthly' | 'once';
  weekdays?: number[]; // 0=الأحد … 6=السبت
  monthDay?: number;
  timeOfDay: string;
  leadDays: number;
  linkTab: string;
};

const SEEDS: Seed[] = [
  {
    title: 'إرسال السراكي للاعتماد',
    body: 'راجع سراكي الأسبوع وابعتها للاعتماد النهاردة — الكشف بيدخل سلسلة المديرين وبعدها بيروح جوجل شيت.',
    icon: '📤', level: 'warn', schedule: 'weekly', weekdays: [2], timeOfDay: '09:00', leadDays: 1, linkTab: 'submissions',
  },
  {
    title: 'تابع كشوف الأسبوع في سلسلة الاعتماد',
    body: 'شوف في طابور الاعتمادات لو فيه كشف واقف عند معتمد من إمبارح — العمود بيقول واقف عند مين بالظبط.',
    icon: '📋', level: 'info', schedule: 'weekly', weekdays: [3], timeOfDay: '11:00', leadDays: 0, linkTab: 'approvals',
  },
  {
    title: 'دورة سركي المعدات بتقفل يوم 19',
    body: 'راجع أيام التشغيل في الدورة (20 → 19) وابعت الكشف الشهري قبل ما تبدأ دورة جديدة.',
    icon: '🚜', level: 'warn', schedule: 'monthly', monthDay: 19, timeOfDay: '10:00', leadDays: 2, linkTab: 'equipment',
  },
  {
    title: 'اطمّن على النسخة الاحتياطية اليومية',
    body: 'كارت النسخة الاحتياطية في الإعدادات بيقول آخر نسخة راحت Drive إمتى ونجحت ولا لأ. لو فشلت أكتر من يوم، الربط بجوجل محتاج مراجعة.',
    icon: '💾', level: 'info', schedule: 'weekly', weekdays: [0], timeOfDay: '08:00', leadDays: 0, linkTab: 'settings',
  },
  {
    title: 'راجع سجل نشاط الحسابات',
    body: 'كارت "نشاط الحسابات" في الإدارة: مين ما دخلش، ومين عنده سجلات لسه ما اترفعتش، وأي أخطاء رجعت لأجهزة المهندسين. السجل بيتمسح بعد 14 يوم.',
    icon: '📊', level: 'info', schedule: 'weekly', weekdays: [4], timeOfDay: '12:00', leadDays: 0, linkTab: 'admin',
  },
  {
    title: 'حسابات بلا معتمدين مسندين',
    body: 'أي حساب مالوش مدير فريق/مدير تنفيذ مسند، كشوفه بتتخطى المستوى ده وتعدّي من غير اعتماده. افتح كارت كل حساب جديد واتأكد من الإسناد.',
    icon: '🖋️', level: 'info', schedule: 'monthly', monthDay: 1, timeOfDay: '09:00', leadDays: 0, linkTab: 'admin',
  },
  {
    title: 'جرد المخزن آخر الشهر',
    body: 'قارن الرصيد الدفتري بالفعلي وسجّل الفروق قبل قفل الشهر.',
    icon: '📦', level: 'info', schedule: 'monthly', monthDay: 28, timeOfDay: '10:00', leadDays: 1, linkTab: 'inventory',
  },
];

async function main(): Promise<void> {
  const admin =
    (await prisma.user.findFirst({ where: { email: OWNER_EMAIL, role: 'ADMIN' } })) ??
    (await prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { id: 'asc' } }));
  if (!admin) {
    console.error('مفيش حساب أدمن في القاعدة دي — وقفت من غير ما أضيف حاجة.');
    process.exit(1);
  }
  console.log(`الحساب: ${admin.email} (id ${admin.id})`);

  let created = 0;
  let skipped = 0;
  for (const s of SEEDS) {
    const exists = await prisma.notification.findFirst({ where: { title: s.title } });
    if (exists) {
      console.log(`↷ موجود بالفعل: ${s.title}`);
      skipped++;
      continue;
    }
    await prisma.notification.create({
      data: {
        title: s.title,
        body: s.body,
        icon: s.icon,
        level: s.level,
        schedule: s.schedule,
        weekdays: s.weekdays ? s.weekdays.join(',') : null,
        monthDay: s.monthDay ?? null,
        timeOfDay: s.timeOfDay,
        leadDays: s.leadDays,
        active: true,
        audience: 'me',
        linkTab: s.linkTab,
        createdById: admin.id,
      },
    });
    console.log(`✅ اتضاف: ${s.icon} ${s.title}`);
    created++;
  }
  console.log(`\nالنتيجة: ${created} جديد · ${skipped} كان موجود · الإجمالي في القاعدة ${await prisma.notification.count()}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
