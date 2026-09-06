-- سركي المعدات: بالخصم على (أسماء مقاولين JSON) + ملاحظة الخصم
ALTER TABLE `equipment_records` ADD COLUMN `deduct_on` JSON NULL, ADD COLUMN `deduct_note` VARCHAR(255) NULL;
