CREATE TABLE `user_badges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`type` text NOT NULL,
	`course_id` integer,
	`module_id` integer,
	`level` integer,
	`title` text NOT NULL,
	`awarded_at` text NOT NULL,
	`seen_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_badges_course_completed_unique` ON `user_badges` (`user_id`,`course_id`) WHERE "user_badges"."type" = 'course_completed';