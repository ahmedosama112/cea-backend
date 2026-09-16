UPDATE `places` SET `site` = 1 WHERE `site` IS NULL;
ALTER TABLE `places` ALTER COLUMN `site` SET DEFAULT 1;
