ALTER TABLE `purchases` ADD `list_price` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `purchases` ADD `quantity` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE `purchases` SET `list_price` = (SELECT `price` FROM `courses` WHERE `courses`.`id` = `purchases`.`course_id`);--> statement-breakpoint
UPDATE `purchases` SET `quantity` = (SELECT COUNT(*) FROM `coupons` WHERE `coupons`.`purchase_id` = `purchases`.`id`) WHERE EXISTS (SELECT 1 FROM `coupons` WHERE `coupons`.`purchase_id` = `purchases`.`id`);
