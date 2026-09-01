-- فئة الصنف (للفلترة والتنظيم) — القائمة قابلة للإضافة زي وحدات القياس
ALTER TABLE `inventory_items` ADD COLUMN `category` VARCHAR(60) NOT NULL DEFAULT 'عام';
