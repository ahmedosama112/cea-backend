-- AlterTable
ALTER TABLE `submission_row_rejections` ADD COLUMN `disposition` VARCHAR(20) NULL,
 ADD COLUMN `classified_by_id` BIGINT NULL,
 ADD COLUMN `classified_at` DATETIME(3) NULL,
 ADD COLUMN `classification_note` VARCHAR(500) NULL;

-- Preserve external references before a future resend clears the current version's links.
ALTER TABLE `submission_revisions` ADD COLUMN `gsheet_row` INTEGER NULL,
 ADD COLUMN `gdrive_file_id` VARCHAR(120) NULL;

-- CreateTable
CREATE TABLE `correction_tasks` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `source_id` BIGINT NOT NULL,
    `source_revision` INTEGER NOT NULL,
    `sheet_index` INTEGER NOT NULL,
    `row` INTEGER NOT NULL,
    `owner_id` BIGINT NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `requested_by_id` BIGINT NULL,
    `state` VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    `legacy_review` BOOLEAN NOT NULL DEFAULT false,
    `requested_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resent_at` DATETIME(3) NULL,
    `resolved_at` DATETIME(3) NULL,

    INDEX `correction_tasks_owner_id_state_requested_at_idx`(`owner_id`, `state`, `requested_at`),
    INDEX `correction_tasks_state_requested_at_idx`(`state`, `requested_at`),
    UNIQUE INDEX `correction_source_row_key`(`source_id`, `source_revision`, `sheet_index`, `row`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `correction_links` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `task_id` BIGINT NOT NULL,
    `active_task_id` BIGINT NULL,
    `replacement_id` BIGINT NOT NULL,
    `revision` INTEGER NOT NULL,
    `sheet_index` INTEGER NOT NULL,
    `row` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `correction_links_active_task_id_key`(`active_task_id`),
    INDEX `correction_links_replacement_id_revision_idx`(`replacement_id`, `revision`),
    UNIQUE INDEX `correction_attempt_key`(`task_id`, `replacement_id`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `correction_drafts` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `source_id` BIGINT NOT NULL,
    `source_revision` INTEGER NOT NULL,
    `owner_id` BIGINT NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `task_ids` JSON NOT NULL,
    `edits` JSON NOT NULL,
    `submitted_id` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `correction_drafts_owner_id_source_id_idx`(`owner_id`, `source_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `correction_events` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `task_id` BIGINT NOT NULL,
    `actor_id` BIGINT NULL,
    `action` VARCHAR(40) NOT NULL,
    `detail` VARCHAR(1000) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `correction_events_task_id_created_at_idx`(`task_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `correction_tasks` ADD CONSTRAINT `correction_tasks_source_id_fkey` FOREIGN KEY (`source_id`) REFERENCES `submissions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `correction_links` ADD CONSTRAINT `correction_links_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `correction_tasks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `correction_links` ADD CONSTRAINT `correction_links_replacement_id_fkey` FOREIGN KEY (`replacement_id`) REFERENCES `submissions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `correction_drafts` ADD CONSTRAINT `correction_drafts_source_id_fkey` FOREIGN KEY (`source_id`) REFERENCES `submissions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `correction_events` ADD CONSTRAINT `correction_events_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `correction_tasks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- Legacy admin rejection is authoritative only when it was recorded after this version's
-- submission. Stale REJECTED status from an older resend must never return the new version.
UPDATE submissions s SET s.review_state='RETURNED', s.current_level=NULL, s.current_approver_id=NULL
WHERE s.status='REJECTED' AND s.reviewed_at >= s.submitted_at AND s.review_state <> 'RETURNED';

-- Explicit, repeatable backfill: returned submissions only. Never infer corrections from old strikes.
INSERT INTO correction_tasks (source_id, source_revision, sheet_index, `row`, owner_id, reason, requested_by_id, state, legacy_review, requested_at)
SELECT s.id, s.revision, -1, 0, s.user_id,
 COALESCE((SELECT r.note FROM submission_reviews r WHERE r.submission_id=s.id AND r.revision=s.revision AND r.decision='REJECTED' ORDER BY r.created_at DESC LIMIT 1), s.review_note, 'كشف مرفوض — راجع سجل المراجعات'),
 COALESCE((SELECT r.by_user_id FROM submission_reviews r WHERE r.submission_id=s.id AND r.revision=s.revision AND r.decision='REJECTED' ORDER BY r.created_at DESC LIMIT 1), s.reviewed_by_id),
 'OPEN', TRUE,
 COALESCE((SELECT MAX(r.created_at) FROM submission_reviews r WHERE r.submission_id=s.id AND r.revision=s.revision AND r.decision='REJECTED'), s.updated_at)
FROM submissions s WHERE s.review_state='RETURNED'
AND NOT EXISTS (SELECT 1 FROM correction_links l WHERE l.replacement_id=s.id AND l.revision=s.revision)
AND NOT (
 EXISTS (SELECT 1 FROM submission_row_rejections r WHERE r.submission_id=s.id AND r.revision=s.revision)
 AND NOT EXISTS (SELECT 1 FROM submission_row_rejections r WHERE r.submission_id=s.id AND r.revision=s.revision AND (r.disposition IS NULL OR r.disposition <> 'FINAL'))
)
ON DUPLICATE KEY UPDATE source_id=VALUES(source_id);

INSERT INTO correction_events (task_id, actor_id, action, detail)
SELECT t.id, NULL, 'BACKFILLED', 'Migrated from actual RETURNED state; no old row strikes were classified'
FROM correction_tasks t WHERE t.legacy_review=TRUE AND t.`row`=0 AND NOT EXISTS (SELECT 1 FROM correction_events e WHERE e.task_id=t.id AND e.action='BACKFILLED');
