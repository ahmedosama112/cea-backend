-- نوع الكمية "عدد": الواجهة بتبعته من زمان، والسيرفر كان بيرفضه بـ 400 (Invalid enum value) — ده كان سبب سجلات "ما اترفعش"
ALTER TABLE `records` MODIFY `qty_type` ENUM('يومية', 'ساعة', 'مقطوعية', 'عدد') NOT NULL DEFAULT 'يومية';
ALTER TABLE `contractors` MODIFY `rate_type` ENUM('يومية', 'ساعة', 'مقطوعية', 'عدد') NULL;
