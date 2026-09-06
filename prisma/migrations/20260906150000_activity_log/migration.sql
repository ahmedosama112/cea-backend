-- سجل نشاط الحسابات (دخول/مزامنة/أخطاء) — للأدمن في كارت الحساب
CREATE TABLE `activity_logs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NULL,
  `email` VARCHAR(190) NOT NULL,
  `event` VARCHAR(20) NOT NULL,
  `detail` VARCHAR(300) NULL,
  `status` INT NULL,
  `path` VARCHAR(160) NULL,
  `ip` VARCHAR(45) NULL,
  `device` VARCHAR(160) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `activity_logs_user_id_created_at_idx`(`user_id`, `created_at`),
  INDEX `activity_logs_created_at_idx`(`created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `activity_logs` ADD CONSTRAINT `activity_logs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
