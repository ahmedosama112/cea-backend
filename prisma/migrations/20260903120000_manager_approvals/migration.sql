-- AlterTable
ALTER TABLE `submissions` ADD COLUMN `current_level` VARCHAR(60) NULL,
    ADD COLUMN `review_state` VARCHAR(20) NOT NULL DEFAULT 'IN_REVIEW',
    ADD COLUMN `revision` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `users` ADD COLUMN `approval_level` VARCHAR(60) NULL;

-- CreateTable
CREATE TABLE `submission_reviews` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `submission_id` BIGINT NOT NULL,
    `level` VARCHAR(60) NOT NULL,
    `decision` VARCHAR(20) NOT NULL,
    `note` VARCHAR(500) NULL,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `by_user_id` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `submission_reviews_submission_id_idx`(`submission_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `submissions_review_state_idx` ON `submissions`(`review_state`);

-- AddForeignKey
ALTER TABLE `submission_reviews` ADD CONSTRAINT `submission_reviews_submission_id_fkey` FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `submission_reviews` ADD CONSTRAINT `submission_reviews_by_user_id_fkey` FOREIGN KEY (`by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
