-- (أكتوبر 2026) السينيور يعتمد للجونيور: خطوة اختيارية قبل مدير الفريق. السلسلة نفسها (TL→CM→PM) مابتتغيرش —
-- عمود فاضي = مفيش خطوة سينيور (السلوك القديم بالظبط) فمفيش أي كشف أو حساب حالي بيتأثر بالترحيل.
ALTER TABLE `users` ADD COLUMN `approver_sr_id` BIGINT NULL;
ALTER TABLE `users` ADD CONSTRAINT `users_approver_sr_id_fkey` FOREIGN KEY (`approver_sr_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `user_projects` ADD COLUMN `approver_sr_id` BIGINT NULL;
ALTER TABLE `user_projects` ADD CONSTRAINT `user_projects_approver_sr_id_fkey` FOREIGN KEY (`approver_sr_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
