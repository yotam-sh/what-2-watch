// ---------------------------------------------------------------------------
// Reconciliation — the read-side join across Plex and Letterboxd watch
// history. Both sources write independently into `watch_events` (Phase 2
// owns Plex's writes, src/lib/letterboxd/sync.ts owns Letterboxd's); this
// module never writes anything itself, only reads whatever both phases have
// put there, joined on the composite (tmdb_id, media_type) key — the free
// join key constraint 17 calls out (`tmdb:movieId`/`tmdb:tvId` on every
// Letterboxd diary entry, `Guid` elements on every Plex item).
//
// A film watched on both sources is, by design, TWO rows in `watch_events`
// (source='plex' and source='letterboxd') and exactly ONE row in `titles` —
// that's the correct shape per the plan's verification step 6, not a bug to
// collapse away at the storage layer. This module only collapses them for
// *read* consumers (the UI, Phase 5) that want a single "have I seen this"
// view.
// ---------------------------------------------------------------------------

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { titles, watchEvents } from "@/db/schema";

export type MediaType = "movie" | "tv";
export type WatchSource = "plex" | "letterboxd";

export interface RatedTitle {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  year: number | null;
  rating: number;
  watchedAt: Date;
  isRewatch: boolean;
}

/** Letterboxd ratings are the strongest explicit taste signal available —
 *  Plex gives sparse-to-no ratings (per the plan). Phase 5's taste model
 *  should read through here rather than querying `watch_events` directly.
 *
 *  Returns one row per *rated* watch event, newest first — a user can rate
 *  the same film differently across separate rewatches, and both are
 *  legitimate signal. Callers that want a single rating per title should
 *  take the first (most recent) entry per (tmdbId, mediaType). */
export function getRatedTitles(userId: string): RatedTitle[] {
  const rows = db
    .select({
      tmdbId: watchEvents.tmdbId,
      mediaType: watchEvents.mediaType,
      title: titles.title,
      year: titles.year,
      rating: watchEvents.rating,
      watchedAt: watchEvents.watchedAt,
      isRewatch: watchEvents.isRewatch,
    })
    .from(watchEvents)
    .innerJoin(titles, and(eq(watchEvents.tmdbId, titles.tmdbId), eq(watchEvents.mediaType, titles.mediaType)))
    .where(and(eq(watchEvents.userId, userId), eq(watchEvents.source, "letterboxd")))
    .orderBy(desc(watchEvents.watchedAt))
    .all();

  const rated: RatedTitle[] = [];
  for (const row of rows) {
    if (row.rating === null) continue; // unrated — constraint 19, never coerced to 0
    rated.push({
      tmdbId: row.tmdbId,
      mediaType: row.mediaType as MediaType,
      title: row.title,
      year: row.year,
      rating: row.rating,
      watchedAt: row.watchedAt,
      isRewatch: row.isRewatch ?? false,
    });
  }
  return rated;
}

export interface ReconciledWatch {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  year: number | null;
  sources: WatchSource[];
  watchCount: number;
  firstWatchedAt: Date;
  lastWatchedAt: Date;
  /** Most recent Letterboxd rating for this title, if any — null if never
   *  rated on Letterboxd (whether or not it was watched there at all). */
  letterboxdRating: number | null;
}

/** Joins every `watch_events` row for a user, across both sources, on
 *  (tmdb_id, media_type) — one ReconciledWatch per title, listing every
 *  source that recorded a watch and rolling up counts/dates. */
export function getReconciledWatchHistory(userId: string): ReconciledWatch[] {
  const rows = db
    .select({
      tmdbId: watchEvents.tmdbId,
      mediaType: watchEvents.mediaType,
      title: titles.title,
      year: titles.year,
      source: watchEvents.source,
      watchedAt: watchEvents.watchedAt,
      rating: watchEvents.rating,
    })
    .from(watchEvents)
    .innerJoin(titles, and(eq(watchEvents.tmdbId, titles.tmdbId), eq(watchEvents.mediaType, titles.mediaType)))
    .where(eq(watchEvents.userId, userId))
    .all();

  const byTitle = new Map<string, ReconciledWatch>();
  for (const row of rows) {
    const key = `${row.tmdbId}:${row.mediaType}`;
    const mediaType = row.mediaType as MediaType;
    const source = row.source as WatchSource;
    const existing = byTitle.get(key);

    if (!existing) {
      byTitle.set(key, {
        tmdbId: row.tmdbId,
        mediaType,
        title: row.title,
        year: row.year,
        sources: [source],
        watchCount: 1,
        firstWatchedAt: row.watchedAt,
        lastWatchedAt: row.watchedAt,
        letterboxdRating: source === "letterboxd" ? row.rating : null,
      });
      continue;
    }

    if (!existing.sources.includes(source)) existing.sources.push(source);
    existing.watchCount += 1;
    if (row.watchedAt.getTime() < existing.firstWatchedAt.getTime()) existing.firstWatchedAt = row.watchedAt;
    if (row.watchedAt.getTime() > existing.lastWatchedAt.getTime()) {
      existing.lastWatchedAt = row.watchedAt;
      if (source === "letterboxd" && row.rating !== null) existing.letterboxdRating = row.rating;
    } else if (source === "letterboxd" && row.rating !== null && existing.letterboxdRating === null) {
      existing.letterboxdRating = row.rating;
    }
  }

  return [...byTitle.values()];
}
