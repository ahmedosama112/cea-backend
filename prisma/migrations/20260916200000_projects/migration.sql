-- المشاريع (قابلة للتوسع بلا حد 1/2) + المشاريع المحمّلة على كل حساب مهندس بمعتمديها الخاصين
CREATE TABLE `projects` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(120) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `projects_name_key`(`name`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `user_projects` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NOT NULL,
  `project_id` INTEGER NOT NULL,
  `approver_tl_id` BIGINT NULL,
  `approver_cm_id` BIGINT NULL,
  `approver_pm_id` BIGINT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `user_projects_user_id_project_id_key`(`user_id`, `project_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `user_projects` ADD CONSTRAINT `user_projects_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `user_projects` ADD CONSTRAINT `user_projects_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `user_projects` ADD CONSTRAINT `user_projects_approver_tl_id_fkey` FOREIGN KEY (`approver_tl_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `user_projects` ADD CONSTRAINT `user_projects_approver_cm_id_fkey` FOREIGN KEY (`approver_cm_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `user_projects` ADD CONSTRAINT `user_projects_approver_pm_id_fkey` FOREIGN KEY (`approver_pm_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- المشروعان القديمان (1 و2) بنفس الأسماء الحالية في app_config (site1Name/site2Name) — أو الافتراضي لو مش موجودة
INSERT INTO `projects` (`id`, `name`, `created_at`) VALUES
  (1, COALESCE((SELECT `value` FROM `app_config` WHERE `key` = 'site1Name'), 'كومباوند جريني'), NOW(3)),
  (2, COALESCE((SELECT `value` FROM `app_config` WHERE `key` = 'site2Name'), 'أزاليا'), NOW(3));

-- مشروع أماكن الكشف — بيحدد معتمدي المشروع ده على حساب المهندس. null = المعتمدين الافتراضيين
ALTER TABLE `submissions` ADD COLUMN `project_id` INTEGER NULL;

-- الأماكن اللي الأدمن حدد مشروعها عنده بس: نفس الاسم عند المهندسين (من غير مشروع) ياخد نفس المشروع
UPDATE `places` p
  JOIN (SELECT `name`, MIN(`site`) AS `site` FROM `places` WHERE `site` IS NOT NULL GROUP BY `name`) x ON x.`name` = p.`name`
  SET p.`site` = x.`site`
  WHERE p.`site` IS NULL;
