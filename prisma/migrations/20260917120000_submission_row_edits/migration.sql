-- تعديل سطر في الكشف (لمدير المشروع بس) بدل شطبه: العدد/السعر/البيان/الخصم على، بسبب إلزامي
CREATE TABLE `submission_row_edits` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `submission_id` BIGINT NOT NULL,
  `revision` INT NOT NULL DEFAULT 0,
  `sheet_index` INT NOT NULL,
  `row` INT NOT NULL,
  `label` VARCHAR(190) NOT NULL,
  `level` VARCHAR(60) NOT NULL,
  `note` VARCHAR(500) NOT NULL,
  `qty_from` VARCHAR(60) NULL,
  `qty_to` VARCHAR(60) NULL,
  `price_from` VARCHAR(60) NULL,
  `price_to` VARCHAR(60) NULL,
  `notes_from` TEXT NULL,
  `notes_to` TEXT NULL,
  `deduct_from` TEXT NULL,
  `deduct_to` TEXT NULL,
  `total_from` VARCHAR(60) NULL,
  `total_to` VARCHAR(60) NULL,
  `by_user_id` BIGINT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `sre_sub_rev_sheet_row_key`(`submission_id`, `revision`, `sheet_index`, `row`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `submission_row_edits` ADD CONSTRAINT `submission_row_edits_submission_id_fkey` FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `submission_row_edits` ADD CONSTRAINT `submission_row_edits_by_user_id_fkey` FOREIGN KEY (`by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
