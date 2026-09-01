-- CreateTable
CREATE TABLE `inventory_items` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `site` INTEGER NOT NULL DEFAULT 1,
    `code` VARCHAR(60) NOT NULL,
    `name` VARCHAR(190) NOT NULL,
    `unit` VARCHAR(60) NOT NULL,
    `qty` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `min_qty` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `inventory_items_site_code_key`(`site`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_moves` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `item_id` BIGINT NOT NULL,
    `type` ENUM('IN', 'OUT', 'ADJUST') NOT NULL,
    `qty` DECIMAL(12, 2) NOT NULL,
    `by_user_id` BIGINT NULL,
    `note` VARCHAR(500) NULL,
    `issue_request_id` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `stock_moves_item_id_created_at_idx`(`item_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `issue_requests` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `status` ENUM('SUBMITTED', 'APPROVED', 'FULFILLED', 'REJECTED') NOT NULL DEFAULT 'SUBMITTED',
    `note` VARCHAR(500) NULL,
    `review_note` VARCHAR(500) NULL,
    `reviewed_by_id` BIGINT NULL,
    `reviewed_at` DATETIME(3) NULL,
    `fulfilled_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `issue_requests_user_id_created_at_idx`(`user_id`, `created_at`),
    INDEX `issue_requests_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `issue_request_lines` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `request_id` BIGINT NOT NULL,
    `item_id` BIGINT NOT NULL,
    `qty` DECIMAL(12, 2) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_requests` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `item_id` BIGINT NOT NULL,
    `qty_requested` DECIMAL(12, 2) NOT NULL,
    `qty_at_request` DECIMAL(12, 2) NOT NULL,
    `status` ENUM('OPEN', 'PURCHASED', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    `by_user_id` BIGINT NULL,
    `note` VARCHAR(500) NULL,
    `resolved_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `purchase_requests_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `stock_moves` ADD CONSTRAINT `stock_moves_item_id_fkey` FOREIGN KEY (`item_id`) REFERENCES `inventory_items`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_moves` ADD CONSTRAINT `stock_moves_by_user_id_fkey` FOREIGN KEY (`by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_moves` ADD CONSTRAINT `stock_moves_issue_request_id_fkey` FOREIGN KEY (`issue_request_id`) REFERENCES `issue_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `issue_requests` ADD CONSTRAINT `issue_requests_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `issue_request_lines` ADD CONSTRAINT `issue_request_lines_request_id_fkey` FOREIGN KEY (`request_id`) REFERENCES `issue_requests`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `issue_request_lines` ADD CONSTRAINT `issue_request_lines_item_id_fkey` FOREIGN KEY (`item_id`) REFERENCES `inventory_items`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_requests` ADD CONSTRAINT `purchase_requests_item_id_fkey` FOREIGN KEY (`item_id`) REFERENCES `inventory_items`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_requests` ADD CONSTRAINT `purchase_requests_by_user_id_fkey` FOREIGN KEY (`by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

