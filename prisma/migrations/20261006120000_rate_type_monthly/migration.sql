-- نوع الكمية "شهرية" (أكتوبر 2026): خيار جديد في تسجيل السركي — بيتضاف لكل الأعمدة اللي بتستخدم RateType
ALTER TABLE `records` MODIFY `qty_type` ENUM('يومية', 'ساعة', 'مقطوعية', 'عدد', 'شهرية') NOT NULL DEFAULT 'يومية';
ALTER TABLE `contractors` MODIFY `rate_type` ENUM('يومية', 'ساعة', 'مقطوعية', 'عدد', 'شهرية') NULL;
ALTER TABLE `rent_requests` MODIFY `qty_type` ENUM('يومية', 'ساعة', 'مقطوعية', 'عدد', 'شهرية') NOT NULL DEFAULT 'يومية';
