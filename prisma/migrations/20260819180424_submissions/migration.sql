-- CreateTable
CREATE TABLE `submissions` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `file_id` BIGINT NOT NULL,
    `contractor_name` VARCHAR(190) NOT NULL,
    `place_name` VARCHAR(190) NULL,
    `week_start` DATE NOT NULL,
    `week_end` DATE NOT NULL,
    `total` DECIMAL(12, 2) NOT NULL,
    `records_count` INTEGER NOT NULL,
    `engineer_note` VARCHAR(500) NULL,
    `status` ENUM('SUBMITTED', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'SUBMITTED',
    `review_note` VARCHAR(500) NULL,
    `reviewed_by_id` BIGINT NULL,
    `reviewed_at` DATETIME(3) NULL,
    `gdrive_file_id` VARCHAR(120) NULL,
    `gsheet_row` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `submissions_user_id_created_at_idx`(`user_id`, `created_at`),
    INDEX `submissions_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `submissions` ADD CONSTRAINT `submissions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `submissions` ADD CONSTRAINT `submissions_file_id_fkey` FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
