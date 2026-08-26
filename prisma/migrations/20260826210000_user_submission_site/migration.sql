-- الموقع/المشروع المنفصل (1 أو 2): كل موقع له Google Sheet وApps Script ومديرين مختلفين
ALTER TABLE `users` ADD COLUMN `site` INTEGER NOT NULL DEFAULT 1;

-- تثبيت موقع التسليم وقت الإنشاء — gsheetRow رقم صف داخل شيت هذا الموقع تحديدًا
ALTER TABLE `submissions` ADD COLUMN `site` INTEGER NOT NULL DEFAULT 1;
