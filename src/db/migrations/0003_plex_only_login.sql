-- ---------------------------------------------------------------------------
-- Plex-only login migration.
--
-- `users` drops `password_hash`/`kdf_salt` (there is no password any more)
-- and gains `plex_account_id`/`plex_username`/`plex_email`/`plex_thumb` —
-- identity is now the Plex account, resolved via plex.tv's `/api/v2/user`
-- at login time (see src/lib/plex/account.ts). `plex_links.key_scope`'s
-- default flips from 'user' to 'server': every token this app writes from
-- now on is encrypted under serverVault, since there is no password-derived
-- key to encrypt it under instead.
--
-- *** EXISTING `users` ROWS CANNOT BE MIGRATED. ***
-- A pre-existing user has no Plex account id — there is nothing to populate
-- the new NOT NULL/UNIQUE `plex_account_id` with, and no default or backfill
-- exists that wouldn't corrupt the new identity model. This migration
-- DELETEs every pre-existing `users` row before rebuilding the table; the
-- `ON DELETE CASCADE` on every FK that references `users.id` (schema.ts)
-- takes every dependent row with it — plex_links, letterboxd_links,
-- plex_items, watch_events, watchlist_items, interactions, cf_user_factors,
-- ltr_models, sync_state.
--
-- This is acceptable ONLY because nothing is in production yet: the dev DB
-- this migration was authored against held exactly 4 disposable test users
-- and their fixture data, all of which this migration destroys. Do not
-- reuse this pattern once real users exist — a real migration would need an
-- actual re-linking flow instead of a DELETE.
DELETE FROM `users`;
--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`plex_account_id` text NOT NULL,
	`plex_username` text NOT NULL,
	`plex_email` text NOT NULL,
	`plex_thumb` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
DROP TABLE `users`;
--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_plex_account_id_unique` ON `users` (`plex_account_id`);
--> statement-breakpoint
CREATE TABLE `__new_plex_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_identifier` text NOT NULL,
	`token_ciphertext` text NOT NULL,
	`key_scope` text DEFAULT 'server' NOT NULL,
	`machine_identifier` text,
	`cached_connection_uri` text,
	`connection_checked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "plex_links_key_scope_check" CHECK("__new_plex_links"."key_scope" IN ('user', 'server'))
);
--> statement-breakpoint
INSERT INTO `__new_plex_links`("id", "user_id", "client_identifier", "token_ciphertext", "key_scope", "machine_identifier", "cached_connection_uri", "connection_checked_at", "created_at") SELECT "id", "user_id", "client_identifier", "token_ciphertext", "key_scope", "machine_identifier", "cached_connection_uri", "connection_checked_at", "created_at" FROM `plex_links`;
--> statement-breakpoint
DROP TABLE `plex_links`;
--> statement-breakpoint
ALTER TABLE `__new_plex_links` RENAME TO `plex_links`;
--> statement-breakpoint
CREATE UNIQUE INDEX `plex_links_user_id_unique` ON `plex_links` (`user_id`);
