-- تعديل هدام عمدًا: الوحدة مخفية ومفيهاش صفوف إنتاج بعد، فمفيش داعي لأي ترحيل بيانات
-- الأعمدة الجديدة NOT NULL بلا default، فالجدول لازم يبقى فاضي — أي صفوف موجودة تبع تجربة محلية
DELETE FROM `rent_requests`;

ALTER TABLE `rent_requests`
  DROP COLUMN `date_from`,
  DROP COLUMN `date_to`,
  ADD COLUMN `day` VARCHAR(20) NOT NULL,
  ADD COLUMN `date` DATE NOT NULL,
  MODIFY `qty` DECIMAL(10, 2) NOT NULL,
  ADD COLUMN `qty_type` ENUM('يومية', 'ساعة', 'مقطوعية', 'عدد') NOT NULL DEFAULT 'يومية',
  ADD COLUMN `price` DECIMAL(10, 2) NOT NULL,
  ADD COLUMN `total` DECIMAL(10, 2) NOT NULL;

CREATE INDEX `rent_requests_user_id_date_idx` ON `rent_requests`(`user_id`, `date`);
