-- مقاولو العمالة (بالمياومة) — الأدمن بيحدد مين هما؛ كشوفهم لازم تتبعت لوحدها بلا أي مقاول تاني
ALTER TABLE `contractors` ADD COLUMN `is_labor` BOOLEAN NOT NULL DEFAULT false;

-- مقاولا العمالة الحاليين (19 سبتمبر 2026)
UPDATE `contractors` SET `is_labor` = 1 WHERE `name` IN ('أحمد عيد', 'محمد أحمد الليثي');

-- أيام العمالة المعتمدة فعليًا لكل مقاول عمالة في الكشف (بعد أي شطب/تعديل سطور) — لتقرير مقاولين العمالة
CREATE TABLE `submission_labor_days` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `submission_id` BIGINT NOT NULL,
  `contractor_name` VARCHAR(190) NOT NULL,
  `days` DECIMAL(10, 2) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `sld_sub_contractor_key`(`submission_id`, `contractor_name`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `submission_labor_days` ADD CONSTRAINT `submission_labor_days_submission_id_fkey` FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
