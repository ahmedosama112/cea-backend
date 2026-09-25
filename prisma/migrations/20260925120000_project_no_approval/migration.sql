-- مشروع بدون اعتماد: الكشوف عليه بتروح الشيت على طول
ALTER TABLE `projects` ADD COLUMN `no_approval` BOOLEAN NOT NULL DEFAULT false;
