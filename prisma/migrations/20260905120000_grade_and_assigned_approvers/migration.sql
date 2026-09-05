-- درجة الحساب + إسناد معتمدين محددين لكل حساب
-- approval_level كان بياخد أسماء المستويات التلاتة نفسها، فبنعيد تسميته لـ grade ونحتفظ بالقيم كما هي
ALTER TABLE `users` CHANGE COLUMN `approval_level` `grade` VARCHAR(60) NULL;
UPDATE `users` SET `grade` = 'junior' WHERE `grade` IS NULL OR `grade` = '';
ALTER TABLE `users` MODIFY COLUMN `grade` VARCHAR(60) NOT NULL DEFAULT 'junior';

ALTER TABLE `users`
  ADD COLUMN `approver_tl_id` BIGINT NULL,
  ADD COLUMN `approver_cm_id` BIGINT NULL,
  ADD COLUMN `approver_pm_id` BIGINT NULL;

ALTER TABLE `users` ADD CONSTRAINT `users_approver_tl_id_fkey` FOREIGN KEY (`approver_tl_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `users` ADD CONSTRAINT `users_approver_cm_id_fkey` FOREIGN KEY (`approver_cm_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `users` ADD CONSTRAINT `users_approver_pm_id_fkey` FOREIGN KEY (`approver_pm_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- الكشوف اللي لسه في السلسلة وقت النشر: current_approver_id = NULL معناها "أي معتمد في المستوى ده"
-- (السلوك القديم بالظبط) — عشان مفيش كشف شغال يعلّق بعد الترحيل
ALTER TABLE `submissions` ADD COLUMN `current_approver_id` BIGINT NULL;
CREATE INDEX `submissions_current_approver_id_idx` ON `submissions`(`current_approver_id`);
