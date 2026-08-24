CREATE TABLE `cf_item_factors` (
	`tmdb_id` integer NOT NULL,
	`media_type` text NOT NULL,
	`factors` blob NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`tmdb_id`, `media_type`),
	FOREIGN KEY (`tmdb_id`,`media_type`) REFERENCES `titles`(`tmdb_id`,`media_type`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `cf_user_factors` (
	`user_id` text PRIMARY KEY NOT NULL,
	`factors` blob NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ltr_models` (
	`user_id` text PRIMARY KEY NOT NULL,
	`weights` text NOT NULL,
	`bias` real NOT NULL,
	`training_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
