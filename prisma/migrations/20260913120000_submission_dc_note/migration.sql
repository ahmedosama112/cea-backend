-- ملاحظة الـDC (عمود E في جوجل شيت) بتتخزن على التسليم — عشان جوب sheetWatch يعرف إنها اتغيّرت
-- ويعلّم عليها "لسه ما اتشافتش" (dc_note_seen_at فاضي لحد ما المهندس يضغط "شفت الملاحظة")
ALTER TABLE `submissions` ADD COLUMN `dc_note` TEXT NULL;
ALTER TABLE `submissions` ADD COLUMN `dc_note_at` DATETIME(3) NULL;
ALTER TABLE `submissions` ADD COLUMN `dc_note_seen_at` DATETIME(3) NULL;
