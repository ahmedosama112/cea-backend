/* eslint-disable no-console */
// يزرع نفس البيانات الافتراضية الموجودة حرفيًا في app.js (DEFAULT_CONTRACTORS/PLACES/INSPECTORS/ITEMS)
// لأول مستخدم ADMIN — يُشغَّل بـ: npm run db:seed
// آمن للإعادة: يتخطى أي عنصر موجود بالفعل بنفس الاسم.
import { PrismaClient, RateType } from '@prisma/client';
import * as readline from 'readline';
import bcrypt from 'bcryptjs';
import { newPasswordSchema } from '../src/schema/auth.schema';

const prisma = new PrismaClient();

const AR_TO_ENUM: Record<string, RateType> = { يومية: 'DAILY', ساعة: 'HOURLY', مقطوعية: 'LUMPSUM' };

const DEFAULT_CONTRACTORS = [
  { name: 'علاء أحمد محمود', spec: 'مبيض محارة', rateType: 'يومية' },
  { name: 'طارق فؤاد التعلب', spec: 'إيجار معدات ( لودر )', rateType: 'ساعة' },
  { name: 'محمد عبدالراضي أحمد', spec: 'إيجار معدات ( هيلتي )', rateType: 'ساعة' },
  { name: 'حمدي صديق محمد', spec: 'مقاول عمال / نحات', rateType: 'يومية' },
  { name: 'عطا محمد بخيت', spec: 'رخام', rateType: 'مقطوعية' },
  { name: 'علي هاشم عبدالحميد', spec: 'حداد', rateType: 'مقطوعية' },
  { name: 'زكريا إبراهيم إسماعيل', spec: 'نقاش', rateType: 'يومية' },
  { name: 'أحمد عيد عطاالله', spec: 'مقاول عمال', rateType: 'يومية' },
  { name: 'محمد أحمد الليثي', spec: 'مقاول عمال', rateType: 'يومية' },
  { name: 'محمد محمود دياب', spec: 'مقاول شدة', rateType: 'مقطوعية' },
];

const DEFAULT_PLACES = ['عمارة 27', 'عمارة 28', 'مقايسة عمارة 27 و 28', 'لاند سكيب'];

const DEFAULT_INSPECTORS = ['م. عمرو زكريا'];

const DEFAULT_ITEMS: Array<{ cat: string; name: string }> = [
  { cat: 'عزل', name: 'عزل بيتومين 4مم للأسطح' },
  { cat: 'بياض داخلي', name: 'بياض سلالم ومداخل' },
  { cat: 'بياض داخلي', name: 'بياض حوائط وأسقف الوحدات' },
  { cat: 'بياض داخلي', name: 'بياض تخشين البدروم والجراجات' },
  { cat: 'بياض خارجي', name: 'بياض تخشين واجهات خارجية' },
  { cat: 'بياض خارجي', name: 'بياض حوائط المناور' },
  { cat: 'بياض خارجي', name: 'عراميس طولية للواجهات' },
  { cat: 'دهانات داخلية', name: 'دهان أسقف وحوائط سلالم وطرقات' },
  { cat: 'دهانات داخلية', name: 'دهان زخرفي حوائط البدروم' },
  { cat: 'دهانات داخلية', name: 'دهان بيتومين أسقف البدروم' },
  { cat: 'دهانات خارجية', name: 'دهان واجهات خارجية' },
  { cat: 'دهانات خارجية', name: 'دهان زخرفي المناور' },
  { cat: 'سيراميك', name: 'سيراميك بلاتينو 60×60 أرضيات' },
  { cat: 'رخام', name: 'درج جرانيت رمادي سلم رئيسي' },
  { cat: 'رخام', name: 'درج رخام صيني منيا سلم هروب' },
  { cat: 'رخام', name: 'درج جرانيت خارجي للمداخل' },
  { cat: 'رخام', name: 'ترابيع جرانيت رمادي مدخل وبسطات' },
  { cat: 'رخام', name: 'ترابيع رخام صيني بسطات هروب' },
  { cat: 'رخام', name: 'ترابيع جرانيت أسود داغش مدخل' },
  { cat: 'بلاط', name: 'بلاط موزايكو غرف الخدمات' },
  { cat: 'بلاط', name: 'بلاط موزايكو أسطح' },
  { cat: 'جبس', name: 'أسقف معلقة جبسية المدخل الرئيسي' },
  { cat: 'تكسيات', name: 'تكسية جرانيت رمادي حوائط مدخل' },
  { cat: 'تكسيات', name: 'تكسية حجر طبيعي حوائط مدخل' },
  { cat: 'تكسيات', name: 'تكسية حجر مايكا واجهات' },
  { cat: 'تكسيات', name: 'بازلت أسود أسفل المبنى' },
  { cat: 'أعمال معدنية', name: 'كوبسته سلم رئيسي' },
  { cat: 'أعمال معدنية', name: 'كوبسته سلم هروب' },
  { cat: 'أعمال معدنية', name: 'هاندريل واجهات ارتفاعات متعددة' },
  { cat: 'أعمال معدنية', name: 'سلم حديد بحري سطح الخدمات' },
  { cat: 'فتحات', name: 'باب سيكوريت ماكينة إيطالي مدخل' },
  { cat: 'فتحات', name: 'تركيب أبواب مصفحة الوحدات' },
  { cat: 'متنوعة', name: 'Cement Board حول فتحات زجاجية' },
  { cat: 'متنوعة', name: 'تجاليد HDF بديل خشب مدخل' },
  { cat: 'متنوعة', name: 'مرايا حوائط مدخل رئيسي' },
  { cat: 'متنوعة', name: 'حوامل تكييف حد أقصى 3 حصان' },
  { cat: 'متنوعة', name: 'زوايا بلاستيك حماية أعمدة' },
  { cat: 'كهرباء', name: 'كابلات ألومنيوم تغذية لوحات خدمة' },
  { cat: 'كهرباء', name: 'كابلات ألومنيوم تغذية المصعد' },
  { cat: 'كهرباء', name: 'كابلات نحاس تغذية الشقق 10مم²' },
  { cat: 'كهرباء', name: 'كابلات نحاس تغذية الشقق 16مم²' },
  { cat: 'كهرباء', name: 'كابلات تغذية لوحة تحكم طلمبات' },
  { cat: 'كهرباء', name: 'كابلات تغذية لوحة منور القمامة' },
  { cat: 'كهرباء', name: 'كابل تأريض 70مم² بين اللوحات' },
  { cat: 'كهرباء', name: 'كابل تأريض 16مم² أنظمة خفيف' },
  { cat: 'كهرباء', name: 'صواعد مواسير كابلات القوى' },
  { cat: 'كهرباء', name: 'حامل كابلات 400×100مم' },
  { cat: 'كهرباء', name: 'حامل كابلات 200×100مم' },
  { cat: 'كهرباء', name: 'ترانك تيار خفيف 200×100مم' },
  { cat: 'كهرباء', name: 'لوحة خدمة 27 SER-DB' },
  { cat: 'كهرباء', name: 'لوحة خدمة 28 SER-DB' },
  { cat: 'كهرباء', name: 'صندوق عداد كهرباء كل وحدة' },
  { cat: 'كهرباء', name: 'صندوق صاعد كهرباء' },
  { cat: 'كهرباء', name: 'بريزة 10 أمبير عادية' },
  { cat: 'كهرباء', name: 'بريزة 10 أمبير مقاومة للجو' },
  { cat: 'كهرباء', name: 'بريزة قوى 16 أمبير للكاميرات' },
  { cat: 'كهرباء', name: 'بريزة قوى 16 أمبير RACK IT' },
  { cat: 'كهرباء', name: 'بريزة قوى 16 أمبير FACP' },
  { cat: 'كهرباء', name: 'بريزة قوى 16 أمبير INTERCOM' },
  { cat: 'كهرباء', name: 'بريزة قوى 16 أمبير MATV' },
  { cat: 'كهرباء', name: 'مفتاح فصل حمل طلمبات مياه' },
  { cat: 'كهرباء', name: 'مفتاح فصل حمل منظومة نفايات' },
  { cat: 'كهرباء', name: 'مفتاح فصل حمل المصاعد' },
  { cat: 'كهرباء', name: 'مفتاح إنارة سكة واحدة' },
  { cat: 'كهرباء', name: 'مفتاح إنارة ثنائي لقمة واحدة' },
  { cat: 'كهرباء', name: 'مخرج إنارة الشقق بمواسير فارغة' },
  { cat: 'كهرباء', name: 'مخرج إنارة السلالم والطرقات' },
  { cat: 'كهرباء', name: 'مخرج بريزة عادية خدمات' },
  { cat: 'كهرباء', name: 'مخرج تغذية كاميرات مراقبة' },
  { cat: 'كهرباء', name: 'مخرج كاميرا مراقبة ثابتة' },
  { cat: 'كهرباء', name: 'صواعد مواسير شبكة الدش والانتركم' },
  { cat: 'كهرباء', name: 'صواعد مواسير شبكة الداتا' },
  { cat: 'كهرباء', name: 'نظام تأريض لوحات جهد منخفض' },
  { cat: 'كهرباء', name: 'سبوت لايت LED 4 وات دائري' },
  { cat: 'كهرباء', name: 'تراك لايت LED 8 وات' },
  { cat: 'كهرباء', name: 'بروفايل LED بيوت النور' },
  { cat: 'كهرباء', name: 'شريط LED غير مباشر بيوت النور' },
  { cat: 'صحي', name: 'مواسير بولي بروبلين تغذية 25مم' },
  { cat: 'صحي', name: 'مواسير بولي بروبلين تغذية 32مم' },
  { cat: 'صحي', name: 'مواسير بولي بروبلين تغذية 63مم' },
  { cat: 'صحي', name: 'مواسير بولي بروبلين تغذية 75مم' },
  { cat: 'صحي', name: 'مواسير UPVC مدفونة تغذية 75مم' },
  { cat: 'صحي', name: 'توصيلات تغذية مياه مطبخ' },
  { cat: 'صحي', name: 'توصيلات تغذية مياه حمام' },
  { cat: 'صحي', name: 'مواسير صرف مدفونة 110مم' },
  { cat: 'صحي', name: 'مواسير صرف مدفونة 160مم' },
  { cat: 'صحي', name: 'توصيلات صرف سيفون حمام 75مم' },
  { cat: 'صحي', name: 'توصيلات صرف تواليت 110مم' },
  { cat: 'صحي', name: 'توصيلات صرف مطبخ 75مم' },
  { cat: 'صحي', name: 'مواسير صرف معلقة 110مم' },
  { cat: 'صحي', name: 'مواسير صرف معلقة 75مم' },
  { cat: 'صحي', name: 'مواسير صرف معلقة 50مم' },
  { cat: 'صحي', name: 'جاليتراب بلاستيك 30×30سم' },
  { cat: 'صحي', name: 'جرجوري صرف أمطار 110مم' },
  { cat: 'صحي', name: 'جرجوري صرف أمطار 75مم' },
  { cat: 'صحي', name: 'سيفون أرضية صرف بدروم 75مم' },
  { cat: 'صحي', name: 'غطاء زهر صرف أرضية جراج' },
  { cat: 'صحي', name: 'حنفية غسيل بدروم وسطح' },
];

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

async function main() {
  // الإيميل من env أو إدخال تفاعلي؛ كلمة السر من env فقط حتى لا تُطبع في السجلات.
  let admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { id: 'asc' } });
  if (!admin) {
    const email = process.env.SEED_ADMIN_EMAIL || (await ask('إيميل الأدمن: '));
    if (!email) throw new Error('لا يمكن إنشاء أدمن بدون إيميل — مرر SEED_ADMIN_EMAIL أو أدخله تفاعليًا');
    if (!process.env.SEED_ADMIN_PASSWORD) throw new Error('حدد SEED_ADMIN_PASSWORD لإنشاء الأدمن؛ لن تُولَّد أو تُطبع كلمة مرور');
    const password = newPasswordSchema.parse(process.env.SEED_ADMIN_PASSWORD);
    admin = await prisma.user.create({
      data: { email: email.toLowerCase(), passwordHash: await bcrypt.hash(password, 12), role: 'ADMIN' },
    });
    console.log(`✅ تم إنشاء الأدمن: ${admin.email}`);
  } else {
    console.log(`ℹ الأدمن موجود بالفعل: ${admin.email}`);
  }

  let added = { contractors: 0, places: 0, inspectors: 0, items: 0 };

  for (const c of DEFAULT_CONTRACTORS) {
    const exists = await prisma.contractor.findFirst({ where: { userId: admin.id, name: c.name } });
    if (exists) continue;
    await prisma.contractor.create({
      data: { userId: admin.id, name: c.name, spec: c.spec, rateType: AR_TO_ENUM[c.rateType] },
    });
    added.contractors++;
  }

  for (const name of DEFAULT_PLACES) {
    const exists = await prisma.place.findFirst({ where: { userId: admin.id, name } });
    if (exists) continue;
    await prisma.place.create({ data: { userId: admin.id, name } });
    added.places++;
  }

  for (const name of DEFAULT_INSPECTORS) {
    const exists = await prisma.inspector.findFirst({ where: { userId: admin.id, name } });
    if (exists) continue;
    await prisma.inspector.create({ data: { userId: admin.id, name } });
    added.inspectors++;
  }

  for (const it of DEFAULT_ITEMS) {
    const exists = await prisma.item.findFirst({ where: { userId: admin.id, name: it.name } });
    if (exists) continue;
    await prisma.item.create({ data: { userId: admin.id, category: it.cat, name: it.name } });
    added.items++;
  }

  console.log(
    `✅ Seed اكتمل — أُضيف: ${added.contractors} مقاول، ${added.places} مكان، ${added.inspectors} استشاري، ${added.items} بند`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
