-- ريأكشن/كومنت على كشف في طابور اعتمادات المديرين — kind='reaction' (body=إيموجي) أو kind='comment' (body=نص)
CREATE TABLE `submission_comments` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `submission_id` BIGINT NOT NULL,
  `user_id` BIGINT NOT NULL,
  `kind` VARCHAR(20) NOT NULL,
  `body` VARCHAR(500) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `submission_comments_submission_id_idx`(`submission_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `submission_comments` ADD CONSTRAINT `submission_comments_submission_id_fkey` FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `submission_comments` ADD CONSTRAINT `submission_comments_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
