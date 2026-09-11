-- طلبات الإيجار (معدات/عمالة) — المهندس يطلب، مدير المشروع يعتمد/يرفض قبل أي تعاقد فعلي
CREATE TABLE `rent_requests` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NOT NULL,
  `request_no` VARCHAR(30) NOT NULL,
  `contractor_id` BIGINT NULL,
  `contractor_name` VARCHAR(190) NOT NULL,
  `place_id` BIGINT NULL,
  `place_name` VARCHAR(190) NOT NULL,
  `resource_type` ENUM('EQUIPMENT', 'LABOR') NOT NULL,
  `qty` INTEGER NOT NULL,
  `statement_of_work` TEXT NOT NULL,
  `date_from` DATE NULL,
  `date_to` DATE NULL,
  `status` ENUM('PENDING', 'APPROVED', 'APPROVED_NOTES', 'REJECTED') NOT NULL DEFAULT 'PENDING',
  `decided_at` DATETIME(3) NULL,
  `decided_by_id` BIGINT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `rent_requests_request_no_key`(`request_no`),
  INDEX `rent_requests_user_id_status_idx`(`user_id`, `status`),
  INDEX `rent_requests_user_id_created_at_idx`(`user_id`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `rent_request_reviews` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `rent_request_id` BIGINT NOT NULL,
  `decision` VARCHAR(20) NOT NULL,
  `note` VARCHAR(500) NULL,
  `by_user_id` BIGINT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `rent_request_reviews_rent_request_id_idx`(`rent_request_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `rent_requests` ADD CONSTRAINT `rent_requests_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `rent_requests` ADD CONSTRAINT `rent_requests_contractor_id_fkey` FOREIGN KEY (`contractor_id`) REFERENCES `contractors`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `rent_requests` ADD CONSTRAINT `rent_requests_place_id_fkey` FOREIGN KEY (`place_id`) REFERENCES `places`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `rent_requests` ADD CONSTRAINT `rent_requests_decided_by_id_fkey` FOREIGN KEY (`decided_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `rent_request_reviews` ADD CONSTRAINT `rent_request_reviews_rent_request_id_fkey` FOREIGN KEY (`rent_request_id`) REFERENCES `rent_requests`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `rent_request_reviews` ADD CONSTRAINT `rent_request_reviews_by_user_id_fkey` FOREIGN KEY (`by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
