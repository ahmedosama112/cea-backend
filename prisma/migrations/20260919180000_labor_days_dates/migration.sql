-- يوميات المقاول موزّعة على تواريخها (JSON نصي) — لاكتشاف نفس اليوم لو اتحسب في أكتر من كشف
ALTER TABLE `submission_labor_days` ADD COLUMN `dates` TEXT NULL;
