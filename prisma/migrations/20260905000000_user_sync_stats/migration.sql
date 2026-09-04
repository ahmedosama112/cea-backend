-- إحصاءات مزامنة الجهاز (بيبلّغها التطبيق بعد كل مزامنة) — عشان الأدمن يشوف في إدارة الحسابات
-- عدد السراكي على جهاز كل مهندس وكام سجل لسه ما اترفعش
ALTER TABLE `users`
    ADD COLUMN `sync_local_records` INTEGER NULL,
    ADD COLUMN `sync_unsynced` INTEGER NULL,
    ADD COLUMN `sync_reported_at` DATETIME(3) NULL;
