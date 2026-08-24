-- ---------------------------------------------------------------------------
-- Plex server picker.
--
-- Adds `plex_selected_servers` (see its doc comment in schema.ts for the full
-- "why a separate table" rationale) and retires the single-server fields
-- that used to live on `plex_links` (`machine_identifier`,
-- `cached_connection_uri`, `connection_checked_at`) now that selection and
-- its per-server connection cache are 0..N rows in the new table instead of
-- fields on the one-row-per-user `plex_links`.
--
-- BACKFILL — existing linked users must not go dark:
-- Before those columns are dropped, every `plex_links` row that already has
-- a `machine_identifier` (i.e. every user who has ever synced, and therefore
-- had the old `servers.find(owned) ?? servers[0]` auto-pick run for them) is
-- copied into `plex_selected_servers` as an explicit selection on that same
-- server, carrying its existing connection cache along so the next sync
-- doesn't even need to re-race a connection. A `plex_links` row with a NULL
-- `machine_identifier` (linked but never yet synced) has nothing to copy —
-- that's fine, it's the same "no selection yet" state a brand-new link is
-- in, and src/lib/plex/link.ts's discovery/auto-select-if-single-server path
-- runs exactly as it would for a first-time sync.
CREATE TABLE `plex_selected_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`machine_identifier` text NOT NULL,
	`cached_connection_uri` text,
	`connection_checked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plex_selected_servers_user_machine_unique` ON `plex_selected_servers` (`user_id`,`machine_identifier`);
--> statement-breakpoint
INSERT INTO `plex_selected_servers` (`id`, `user_id`, `machine_identifier`, `cached_connection_uri`, `connection_checked_at`, `created_at`)
SELECT
	lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2)
		|| '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
	`user_id`, `machine_identifier`, `cached_connection_uri`, `connection_checked_at`, `created_at`
FROM `plex_links`
WHERE `machine_identifier` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `plex_links` DROP COLUMN `machine_identifier`;
--> statement-breakpoint
ALTER TABLE `plex_links` DROP COLUMN `cached_connection_uri`;
--> statement-breakpoint
ALTER TABLE `plex_links` DROP COLUMN `connection_checked_at`;
