-- التنبيهات الداخلية: جرس الهيدر + تاب "التنبيهات" (الأدمن بيكتب التنبيه ومواعيده ومستقبليه)
CREATE TABLE `notifications` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(120) NOT NULL,
  `body` VARCHAR(500) NULL,
  `icon` VARCHAR(12) NULL,
  `level` VARCHAR(10) NOT NULL DEFAULT 'info',
  `schedule` VARCHAR(10) NOT NULL DEFAULT 'once',
  `once_date` DATE NULL,
  `weekdays` VARCHAR(20) NULL,
  `month_day` INTEGER NULL,
  `time_of_day` VARCHAR(5) NOT NULL DEFAULT '08:00',
  `lead_days` INTEGER NOT NULL DEFAULT 0,
  `start_date` DATE NULL,
  `end_date` DATE NULL,
  `active` BOOLEAN NOT NULL DEFAULT true,
  `audience` VARCHAR(10) NOT NULL DEFAULT 'me',
  `audience_site` INTEGER NULL,
  `audience_grade` VARCHAR(60) NULL,
  `link_tab` VARCHAR(30) NULL,
  `created_by_id` BIGINT NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  INDEX `notifications_active_idx`(`active`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `notification_targets` (
  `notification_id` BIGINT NOT NULL,
  `user_id` BIGINT NOT NULL,
  INDEX `notification_targets_user_id_idx`(`user_id`),
  PRIMARY KEY (`notification_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `notification_reads` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `notification_id` BIGINT NOT NULL,
  `user_id` BIGINT NOT NULL,
  `occurrence` VARCHAR(10) NOT NULL,
  `done_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `notification_reads_notification_id_user_id_occurrence_key`(`notification_id`, `user_id`, `occurrence`),
  INDEX `notification_reads_user_id_idx`(`user_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `notifications` ADD CONSTRAINT `notifications_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `notification_targets` ADD CONSTRAINT `notification_targets_notification_id_fkey` FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `notification_targets` ADD CONSTRAINT `notification_targets_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `notification_reads` ADD CONSTRAINT `notification_reads_notification_id_fkey` FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `notification_reads` ADD CONSTRAINT `notification_reads_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
