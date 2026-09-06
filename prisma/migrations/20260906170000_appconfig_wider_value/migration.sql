-- توسيع قيمة الإعدادات: مصفوفة "مين يعتمد لمين" (approvalMatrix) بتتخزن JSON وطولها بيعدّي 190 حرف.
-- توسيع فقط — مفيش أي فقد بيانات.
ALTER TABLE `app_config` MODIFY COLUMN `value` VARCHAR(1000) NOT NULL;
