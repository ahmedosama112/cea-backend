-- ربط سطر السركي بطلب الإيجار اللي اتعمل منه.
-- إضافي بحت: عمود nullable + قيد فريد — مافيش أي بيانات بتتغير ولا صف بيتمسح.
-- الـUNIQUE هو ضمان "طلب واحد = سطر واحد" على مستوى قاعدة البيانات، مش على مستوى الكود.
ALTER TABLE `records`
  ADD COLUMN `rent_request_id` BIGINT NULL;

CREATE UNIQUE INDEX `records_rent_request_id_key` ON `records`(`rent_request_id`);

-- حذف الطلب بيسيب السجل قايم بـ NULL (السجل بيانات مالية معتمدة — ما ينفعش يتمسح تبعًا للطلب)
ALTER TABLE `records`
  ADD CONSTRAINT `records_rent_request_id_fkey`
  FOREIGN KEY (`rent_request_id`) REFERENCES `rent_requests`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
