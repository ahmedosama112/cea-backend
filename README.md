# CEA Backend — MySQL + Express API

بديل Supabase لمشروع CEA (متابعة السرايكي): REST API مستقل فوق MySQL، مبني بـ Node.js + TypeScript + Express + Prisma.

> الواجهة الأمامية لا تتصل بقاعدة البيانات مباشرة أبدًا — كل شيء عبر هذا الـ API.

## التشغيل في التطوير (Development)

المتطلبات: Node.js 20.13+ (يدعم watch المدمج)، Docker Desktop.

```bash
# 1. شغّل MySQL (+ Adminer على http://localhost:8080 لتصفح البيانات)
docker compose up -d

# 2. انسخ ملف البيئة وعدّل القيم لو لزم
cp .env.example .env

# 3. ثبّت الاعتماديات
npm install

# 4. أنشئ الجداول
npm run prisma:migrate

# 5. (اختياري) ازرع البيانات الافتراضية + أول مستخدم أدمن
#    مرر SEED_ADMIN_PASSWORD بأمان في البيئة (8 أحرف على الأقل و72 بايت UTF-8 كحد أقصى).
#    مرر SEED_ADMIN_EMAIL أو أدخل الإيميل تفاعليًا؛ كلمة المرور لا تُطبع.
npm run db:seed

# 6. شغّل السيرفر
npm run dev
# → http://localhost:4000  (فحص سريع: GET /health)
```

## صيغة الاستجابة الموحدة

```json
{ "success": true,  "data": { } }
{ "success": false, "message": "غير مصرّح", "code": "UNAUTHORIZED" }
```

الأكواد: `VALIDATION_ERROR` `UNAUTHORIZED` `FORBIDDEN` `NOT_FOUND` `CONFLICT` `RATE_LIMITED` `INTERNAL_ERROR`

## المصادقة

- `POST /api/auth/register` — أول مستخدم يصبح ADMIN تلقائيًا، الباقي ENGINEER
- `POST /api/auth/login` — يرجّع `accessToken` (15 دقيقة) + `refreshToken` (30 يوم)
- `POST /api/auth/refresh` — تدوير التوكن (القديم يُلغى؛ إعادة استخدام توكن ملغي تُبطل كل الجلسات)
- `POST /api/auth/logout` — إبطال الـ refresh token سيرفريًا
- `GET  /api/auth/me` — بيانات المستخدم الحالي
- `POST /api/auth/password-reset/request` ثم `/confirm` — استعادة كلمة السر (التوكن يُعاد حاليًا في الاستجابة لحين ربط SMTP)
- `POST /api/auth/change-password` — تغيير كلمة السر (يُبطل كل الجلسات)

كل ما عدا auth يتطلب هيدر: `Authorization: Bearer <accessToken>` — وكل الاستعلامات مقيّدة ببيانات صاحب التوكن فقط (ownership على مستوى الـ API).

## الكيانات (CRUD قياسي: GET / GET/:id / POST / PUT/:id / DELETE/:id)

| المسار | الكيان | ملاحظات |
|---|---|---|
| `/api/contractors` | المقاولون | `rateType` بالنصوص العربية نفسها: يومية/ساعة/مقطوعية |
| `/api/places` | الأماكن | |
| `/api/inspectors` | الاستشاريون | |
| `/api/items` | البنود | `stages: [{name, pct}]` متداخلة — استبدال كامل عند التعديل |
| `/api/records` | السراكي | انظر أدناه |
| `/api/ir-records` | طلبات الفحص | |
| `/api/todos` | المهام | |
| `/api/exec-records` | الموقف التنفيذي | `stages` + `stageDone` بنفس شكل الواجهة |
| `/api/daily-records` | التقارير اليومية | `photoFileId` يشير لملف مرفوع في `/api/files` |
| `/api/files` | الملفات | `POST` multipart حقل `file` (صور فقط، حد {MAX_UPLOAD_MB}MB)؛ المحتوى عبر `GET /:id/content` خلف ownership |
| `/api/account/settings` | PIN + التوقيع | `GET` / `PUT` جزئي (`pinHash`, `signatureFileId`) |

### `/api/records` (السراكي)

- `GET /api/records?date_from=&date_to=&contractor=&place=&page=&limit=&sort=date|contractor|total&dir=asc|desc`
  - يرجّع `{total, page, limit, rows}` — pagination حقيقي بدل تحميل كل شيء
- `POST` / `PUT/:id` — نفس حقول الواجهة: `day, date, contractor, spec, qty, qtyType, price, discount, place, notes, deductOn[], deductNote, done`
  - **الإجمالي يُحسب على السيرفر** (qty × price − discount) — أي `total` مُرسل يُتجاهل
  - أسماء المقاول/المكان تُحفظ snapshot + تُربط بالـ ID لو موجودة (حذف مقاول لاحقًا لا يكسر السجلات)
- `PATCH /api/records/:id/toggle-done`

## الأمان المطبَّق

Helmet (secure headers)، CORS مقيّد بـ `CORS_ORIGIN`، rate limiting عام + أشد على auth، Zod validation على كل المدخلات، bcrypt (12 rounds)، refresh tokens مخزّنة كـ hash وقابلة للإلغاء، أخطاء موحّدة بدون stack traces، الملفات خلف ownership check (لا static serving)، Prisma (parameterized queries — لا SQL خام).

## البنية

```
src/
  config/        env.ts, prisma.ts
  routes/        تعريف المسارات فقط
  controllers/   استقبال/رد — بدون منطق
  services/      الـ business logic (منقول من app.js كما هو)
  middlewares/   auth, validate, errorHandler
  schema/        Zod schemas
  utils/         tokens, password, crudFactory, AppError...
prisma/
  schema.prisma  17 جدول — انظر التعليقات فيه للمقابلة مع البيانات القديمة
  seed.ts        البيانات الافتراضية من app.js + إنشاء أول أدمن
```

## الإنتاج (Production)

```bash
npm run build
npm run prisma:migrate:deploy
npm start
```

- غيّر `JWT_ACCESS_SECRET` و`JWT_REFRESH_SECRET` — السيرفر يرفض الإقلاع في production بالقيم الافتراضية.
- اضبط `CORS_ORIGIN` على أصل التطبيق الفعلي.
- `DATABASE_URL` لقاعدة الإنتاج — لا تضع كلمات سر في أي ملف مُتتبع في git (`.env` في `.gitignore`).
