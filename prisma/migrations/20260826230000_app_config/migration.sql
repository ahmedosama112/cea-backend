-- إعدادات عامة للتطبيق (أسماء المواقع/المشاريع القابلة للتعديل من الأدمن)
CREATE TABLE `app_config` (
    `key` VARCHAR(60) NOT NULL,
    `value` VARCHAR(190) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
