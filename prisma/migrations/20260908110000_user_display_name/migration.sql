-- الاسم بالعربي لكل حساب (يظهر بدل أول الإيميل)
ALTER TABLE `users` ADD COLUMN `display_name` VARCHAR(120) NULL;
