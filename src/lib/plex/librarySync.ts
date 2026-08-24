// ---------------------------------------------------------------------------
// DB-writing orchestration for the library sync — split out from library.ts
// so that file can stay free of any "@/db/client" import (its pure/network
// functions are unit-tested directly; this file's DB upserts are not, since
// they need either a live PMS or a real SQLite connection to exercise).
//
// See titlesStub.ts for why every resolved item upserts a minimal `titles`
// stub row before referencing it, and library.ts's file header for
// constraints 5/6/7/9 that shaped the scan functions this orchestrates.
// ---------------------------------------------------------------------------

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { plexItems, watchEvents } from "@/db/schema";
import {
  fetchLibrarySections,
  rollupEpisodesToShows,
  scanAllMovies,
  scanAllShows,
  scanWatchedEpisodes,
  type FetchCtx,
  type NormalizedPlexItem,
  type ScanVariantName,
  type ShowRollup,
} from "./library";
import { upsertTitleStub } from "./titlesStub";

export interface UpsertMovieParams {
  userId: string;
  machineIdentifier: string;
  librarySectionId: string;
  item: NormalizedPlexItem;
}

/** Upserts one movie's plex_items row and, if its lastViewedAt advanced
 *  since the last sync (or this is the first time we've seen it), a new
 *  watch_events row. This is what makes repeated syncs idempotent without a
 *  unique constraint on watch_events itself: we only ever add a new event
 *  when Plex reports a *newer* play than what we already recorded. */
export function upsertMovieWatch(params: UpsertMovieParams): void {
  const { userId, machineIdentifier, librarySectionId, item } = params;
  const tmdbId = item.externalIds.tmdbId;
  const mediaType: "movie" | null = tmdbId !== null ? "movie" : null;

  if (tmdbId !== null) {
    upsertTitleStub(tmdbId, "movie", item.title, item.year);
  }

  const existing = db
    .select({ lastViewedAt: plexItems.lastViewedAt })
    .from(plexItems)
    .where(
      and(
        eq(plexItems.userId, userId),
        eq(plexItems.machineIdentifier, machineIdentifier),
        eq(plexItems.ratingKey, item.ratingKey),
      ),
    )
    .get();

  const newLastViewedAt = item.lastViewedAt !== undefined ? new Date(item.lastViewedAt * 1000) : null;
  const previousLastViewedAt = existing?.lastViewedAt ?? null;
  const hasNewPlay =
    newLastViewedAt !== null &&
    (previousLastViewedAt === null || newLastViewedAt.getTime() > previousLastViewedAt.getTime());

  db.insert(plexItems)
    .values({
      userId,
      machineIdentifier,
      ratingKey: item.ratingKey,
      tmdbId: tmdbId ?? undefined,
      mediaType: mediaType ?? undefined,
      librarySectionId,
      type: 1,
      viewCount: item.viewCount,
      lastViewedAt: newLastViewedAt ?? undefined,
      viewOffset: item.viewOffset ?? undefined,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [plexItems.userId, plexItems.machineIdentifier, plexItems.ratingKey],
      set: {
        tmdbId: tmdbId ?? undefined,
        mediaType: mediaType ?? undefined,
        viewCount: item.viewCount,
        lastViewedAt: newLastViewedAt ?? undefined,
        viewOffset: item.viewOffset ?? undefined,
        updatedAt: new Date(),
      },
    })
    .run();

  if (hasNewPlay && tmdbId !== null && newLastViewedAt !== null) {
    db.insert(watchEvents)
      .values({
        userId,
        tmdbId,
        mediaType: "movie",
        source: "plex",
        watchedAt: newLastViewedAt,
        isRewatch: item.viewCount > 1,
      })
      .run();
  }
}

export interface UpsertShowParams {
  userId: string;
  machineIdentifier: string;
  librarySectionId: string;
  show: NormalizedPlexItem; // from scanAllShows — carries leafCount/viewedLeafCount
  rollup: ShowRollup | undefined; // from rollupEpisodesToShows, undefined if no watched episodes
}

/** Upserts one show's plex_items row (leafCount/viewedLeafCount from the
 *  show item itself, viewCount from the episode rollup per constraint 6)
 *  and, on a new play, a watch_events row keyed to the show's tmdb id —
 *  there is no per-episode titles row (titles.media_type is only
 *  'movie'|'tv'), so episode-level detail lives only in plex_items. */
export function upsertShowWatch(params: UpsertShowParams): void {
  const { userId, machineIdentifier, librarySectionId, show, rollup } = params;
  const tmdbId = show.externalIds.tmdbId;
  const mediaType: "tv" | null = tmdbId !== null ? "tv" : null;

  if (tmdbId !== null) {
    upsertTitleStub(tmdbId, "tv", show.title, show.year);
  }

  const totalViewCount = rollup?.totalEpisodeViewCount ?? 0;
  const rollupLastViewedAt = rollup?.lastViewedAt;

  const existing = db
    .select({ lastViewedAt: plexItems.lastViewedAt })
    .from(plexItems)
    .where(
      and(
        eq(plexItems.userId, userId),
        eq(plexItems.machineIdentifier, machineIdentifier),
        eq(plexItems.ratingKey, show.ratingKey),
      ),
    )
    .get();

  const newLastViewedAt = rollupLastViewedAt !== undefined ? new Date(rollupLastViewedAt * 1000) : null;
  const previousLastViewedAt = existing?.lastViewedAt ?? null;
  const hasNewPlay =
    newLastViewedAt !== null &&
    (previousLastViewedAt === null || newLastViewedAt.getTime() > previousLastViewedAt.getTime());

  db.insert(plexItems)
    .values({
      userId,
      machineIdentifier,
      ratingKey: show.ratingKey,
      tmdbId: tmdbId ?? undefined,
      mediaType: mediaType ?? undefined,
      librarySectionId,
      type: 2,
      // Constraint 6: totalViewCount is the sum of *episode* viewCounts,
      // never show.viewCount.
      viewCount: totalViewCount,
      lastViewedAt: newLastViewedAt ?? undefined,
      leafCount: show.leafCount,
      viewedLeafCount: show.viewedLeafCount,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [plexItems.userId, plexItems.machineIdentifier, plexItems.ratingKey],
      set: {
        tmdbId: tmdbId ?? undefined,
        mediaType: mediaType ?? undefined,
        viewCount: totalViewCount,
        lastViewedAt: newLastViewedAt ?? undefined,
        leafCount: show.leafCount,
        viewedLeafCount: show.viewedLeafCount,
        updatedAt: new Date(),
      },
    })
    .run();

  if (hasNewPlay && tmdbId !== null && newLastViewedAt !== null && rollup) {
    db.insert(watchEvents)
      .values({
        userId,
        tmdbId,
        mediaType: "tv",
        source: "plex",
        watchedAt: newLastViewedAt,
        // A rewatch if at least one episode has been played more than once.
        isRewatch: rollup.totalEpisodeViewCount > rollup.watchedEpisodeCount,
      })
      .run();
  }
}

/** Full sync for one user's linked server: every movie library, every show
 *  library. Returns coarse counts for the sync route's response / logging.
 *
 *  PHASE 6 "discover pool": movies now go through scanAllMovies (every movie
 *  in the section, watched or not) instead of scanWatchedMovies — a strict
 *  superset of the old watched-only scan, so this replaces rather than
 *  supplements that call (no point paying for two full network scans of the
 *  same section when one already returns everything). moviesSynced/
 *  showsSynced keep their pre-Phase-6 meaning (count of *watched* items, so
 *  existing UI copy — "Synced N movies, M shows" — doesn't suddenly balloon
 *  to whole-library counts); libraryItemsSynced is the new count of
 *  *unwatched* items written to plex_items (view_count = 0) — i.e. how many
 *  candidates just became available to discover mode. Shows: scanAllShows
 *  already scanned everything, but the loop below used to skip any show with
 *  no watch rollup ("never watched — nothing to sync"). That was the actual
 *  bug: it silently dropped unwatched shows from plex_items entirely.
 *  upsertShowWatch already handles `rollup: undefined` correctly (viewCount
 *  0, no watch_events row — see its own doc comment), so the fix is simply
 *  to stop skipping. */
export async function syncLibraries(params: {
  userId: string;
  machineIdentifier: string;
  connectionUri: string;
  token: string;
  clientIdentifier: string;
}): Promise<{
  moviesSynced: number;
  showsSynced: number;
  /** Count of unwatched items (view_count = 0) newly written to plex_items
   *  across movie and show sections combined — the full-library "discover
   *  pool" size. Reported separately from moviesSynced/showsSynced so it's
   *  visible whether the pool actually populated. */
  libraryItemsSynced: number;
  includeGuidsWorked: boolean | null;
  /** Which library-scan degradation-ladder variant this PMS accepted — see
   *  library.ts's ScanVariantName / SCAN_VARIANTS. Null only if there were
   *  no movie or show sections to scan at all. */
  scanVariant: ScanVariantName | null;
}> {
  const ctx: FetchCtx = {
    connectionUri: params.connectionUri,
    token: params.token,
    clientIdentifier: params.clientIdentifier,
  };
  const sections = await fetchLibrarySections(params.connectionUri, params.token, params.clientIdentifier);

  let moviesSynced = 0;
  let showsSynced = 0;
  let libraryItemsSynced = 0;
  let includeGuidsWorked: boolean | null = null;
  let scanVariant: ScanVariantName | null = null;

  for (const section of sections.filter((s) => s.type === "movie")) {
    const { items, includeGuidsWorked: worked, variantUsed } = await scanAllMovies(ctx, section.key);
    includeGuidsWorked = includeGuidsWorked ?? worked;
    scanVariant = scanVariant ?? variantUsed;
    for (const item of items) {
      upsertMovieWatch({
        userId: params.userId,
        machineIdentifier: params.machineIdentifier,
        librarySectionId: section.key,
        item,
      });
      if (item.viewCount >= 1) {
        moviesSynced += 1;
      } else {
        libraryItemsSynced += 1;
      }
    }
  }

  for (const section of sections.filter((s) => s.type === "show")) {
    const [{ items: episodes, includeGuidsWorked: episodesWorked, variantUsed: episodesVariant }, shows] =
      await Promise.all([scanWatchedEpisodes(ctx, section.key), scanAllShows(ctx, section.key)]);
    includeGuidsWorked = includeGuidsWorked ?? episodesWorked;
    scanVariant = scanVariant ?? episodesVariant;
    const rollups = rollupEpisodesToShows(episodes);
    for (const show of shows) {
      const rollup = rollups.get(show.ratingKey);
      upsertShowWatch({
        userId: params.userId,
        machineIdentifier: params.machineIdentifier,
        librarySectionId: section.key,
        show,
        rollup,
      });
      if (rollup) {
        showsSynced += 1;
      } else {
        libraryItemsSynced += 1;
      }
    }
  }

  return { moviesSynced, showsSynced, libraryItemsSynced, includeGuidsWorked, scanVariant };
}
