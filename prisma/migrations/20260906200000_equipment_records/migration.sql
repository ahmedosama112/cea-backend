-- سركي المعدات (إيجار معدات شهري) — سطر لكل يوم تشغيل
CREATE TABLE `equipment_records` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NOT NULL,
  `contractor` VARCHAR(190) NOT NULL,
  `equipment` VARCHAR(190) NOT NULL,
  `place` VARCHAR(190) NOT NULL,
  `day` VARCHAR(20) NOT NULL,
  `date` DATE NOT NULL,
  `time_from` VARCHAR(5) NOT NULL,
  `time_to` VARCHAR(5) NOT NULL,
  `minutes` INT NOT NULL,
  `works` TEXT NULL,
  `notes` VARCHAR(500) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  INDEX `equipment_records_user_id_date_idx`(`user_id`, `date`),
  INDEX `equipment_records_user_id_equipment_idx`(`user_id`, `equipment`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `equipment_records` ADD CONSTRAINT `equipment_records_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- نوع الكشف على التسليمات: labor (الافتراضي — كل القديم) أو equipment
ALTER TABLE `submissions` ADD COLUMN `kind` VARCHAR(20) NOT NULL DEFAULT 'labor';
