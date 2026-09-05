-- إخفاء صف من طابور "اعتمادات المديرين" فقط (الأدمن): الكشف وسجل المراجعات وجوجل شيت و"تسليماتي" كلهم بيفضلوا زي ما هم
ALTER TABLE `submissions` ADD COLUMN `queue_hidden_at` DATETIME(3) NULL;
