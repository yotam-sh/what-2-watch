CREATE TABLE `interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`media_type` text NOT NULL,
	`action` text NOT NULL,
	`context_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tmdb_id`,`media_type`) REFERENCES `titles`(`tmdb_id`,`media_type`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "interactions_action_check" CHECK("interactions"."action" IN ('shown', 'picked', 'skipped', 'snoozed'))
);
--> statement-breakpoint
CREATE INDEX `interactions_user_tmdb_idx` ON `interactions` (`user_id`,`tmdb_id`);--> statement-breakpoint
CREATE TABLE `letterboxd_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`username` text NOT NULL,
	`last_guid_seen` text,
	`last_polled_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `letterboxd_links_user_id_unique` ON `letterboxd_links` (`user_id`);--> statement-breakpoint
CREATE TABLE `plex_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`machine_identifier` text NOT NULL,
	`rating_key` text NOT NULL,
	`tmdb_id` integer,
	`media_type` text,
	`library_section_id` text,
	`type` integer,
	`view_count` integer DEFAULT 0,
	`last_viewed_at` integer,
	`view_offset` integer,
	`leaf_count` integer,
	`viewed_leaf_count` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tmdb_id`,`media_type`) REFERENCES `titles`(`tmdb_id`,`media_type`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plex_items_user_item_unique` ON `plex_items` (`user_id`,`machine_identifier`,`rating_key`);--> statement-breakpoint
CREATE INDEX `plex_items_user_tmdb_idx` ON `plex_items` (`user_id`,`tmdb_id`);--> statement-breakpoint
CREATE TABLE `plex_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_identifier` text NOT NULL,
	`token_ciphertext` text NOT NULL,
	`key_scope` text DEFAULT 'user' NOT NULL,
	`machine_identifier` text,
	`cached_connection_uri` text,
	`connection_checked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "plex_links_key_scope_check" CHECK("plex_links"."key_scope" IN ('user', 'server'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plex_links_user_id_unique` ON `plex_links` (`user_id`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`last_run_at` integer,
	`last_error` text,
	PRIMARY KEY(`user_id`, `source`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `titles` (
	`tmdb_id` integer NOT NULL,
	`media_type` text NOT NULL,
	`title` text NOT NULL,
	`year` integer,
	`runtime` integer,
	`genres` text,
	`directors` text,
	`cast` text,
	`overview` text,
	`poster_path` text,
	`embedding` blob,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	PRIMARY KEY(`tmdb_id`, `media_type`),
	CONSTRAINT "titles_media_type_check" CHECK("titles"."media_type" IN ('movie', 'tv'))
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`kdf_salt` blob NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `watch_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`media_type` text NOT NULL,
	`source` text NOT NULL,
	`watched_at` integer NOT NULL,
	`rating` real,
	`is_rewatch` integer DEFAULT false,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tmdb_id`,`media_type`) REFERENCES `titles`(`tmdb_id`,`media_type`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "watch_events_source_check" CHECK("watch_events"."source" IN ('plex', 'letterboxd'))
);
--> statement-breakpoint
CREATE INDEX `watch_events_user_tmdb_idx` ON `watch_events` (`user_id`,`tmdb_id`);--> statement-breakpoint
CREATE TABLE `watchlist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`media_type` text NOT NULL,
	`source` text DEFAULT 'plex_discover' NOT NULL,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tmdb_id`,`media_type`) REFERENCES `titles`(`tmdb_id`,`media_type`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_items_user_title_unique` ON `watchlist_items` (`user_id`,`tmdb_id`,`media_type`);