-- شطب سطر من الكشف (رفض جزئي) — المعتمد يشطب يوم معيّن ويكمل الكشف للـ DC بدونه
CREATE TABLE `submission_row_rejections` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `submission_id` BIGINT NOT NULL,
  `revision` INT NOT NULL DEFAULT 0,
  `sheet_index` INT NOT NULL,
  `row` INT NOT NULL,
  `label` VARCHAR(190) NOT NULL,
  `level` VARCHAR(60) NOT NULL,
  `note` VARCHAR(500) NOT NULL,
  `by_user_id` BIGINT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `srr_sub_rev_sheet_row_key`(`submission_id`, `revision`, `sheet_index`, `row`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `submission_row_rejections` ADD CONSTRAINT `submission_row_rejections_submission_id_fkey` FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `submission_row_rejections` ADD CONSTRAINT `submission_row_rejections_by_user_id_fkey` FOREIGN KEY (`by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
