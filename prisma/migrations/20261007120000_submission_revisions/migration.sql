-- (أكتوبر 2026) إعادة إرسال كشف مرفوض: النسخة القديمة بتفضل ظاهرة في طابور الاعتمادات (باهتة) والجديدة سطر فوق بتاريخ إرسالها
ALTER TABLE `submissions` ADD COLUMN `submitted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
-- الكشوف الموجودة: تاريخ الإرسال = تاريخ الكشف (تاريخ إعادة الإرسال القديمة مش متسجّل)
UPDATE `submissions` SET `submitted_at` = `created_at`;

CREATE TABLE `submission_revisions` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `submission_id` BIGINT NOT NULL,
    `revision` INTEGER NOT NULL,
    `file_id` BIGINT NULL,
    `submitted_at` DATETIME(3) NOT NULL,
    `replaced_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `srv_sub_rev_key`(`submission_id`, `revision`),
    INDEX `submission_revisions_file_id_fkey`(`file_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `submission_revisions` ADD CONSTRAINT `submission_revisions_submission_id_fkey` FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `submission_revisions` ADD CONSTRAINT `submission_revisions_file_id_fkey` FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
