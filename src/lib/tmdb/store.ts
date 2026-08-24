// ---------------------------------------------------------------------------
// DB-writing side of TMDB enrichment. Split from client.ts/mapper.ts (which
// stay pure and network-free) for the same reason Phase 2 split
// library.ts/librarySync.ts: this file needs either a live TMDB key or a
// real SQLite connection to exercise, so it isn't unit-tested directly —
// client.ts and mapper.ts, which contain all the actual branching logic, are.
//
// Integration note (from Phase 2, which lands its own minimal stub rows into
// `titles` before referencing them from plex_items/watchlist_items/
// watch_events, via onConflictDoNothing — see src/lib/plex/titlesStub.ts):
// enrichTitle() below MUST use onConflictDoUpdate, not onConflictDoNothing.
// If it used DoNothing, hitting a Plex-authored stub row would silently do
// nothing forever, and Phase 5 would train on titles with no genres, cast,
// runtime, or overview. It also must never include `embedding` in the
// `set` clause — that column belongs to Phase 5, and a stub-fill or
// re-enrichment pass must never clobber a vector that's already been
// computed.
//
// The "already enriched, permanently cached" check (constraint: "TMDB ids
// are immutable — once a title row exists, never re-fetch it except behind
// an explicit refresh") is therefore keyed on whether the metadata columns
// are actually POPULATED, not on row existence and not merely on
// `updatedAt` being set — a stub row exists (and even plausibly could gain
// an unrelated updatedAt touch from other code later) without ever having
// been enriched. `genres` is the signal: enrichTitle() always writes a JSON
// array string here (even "[]" for a title with no genres), while stub rows
// (both this file's ensureTitleStub and Phase 2's titlesStub.ts) never set
// it, leaving it NULL.
// ---------------------------------------------------------------------------

import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { db } from "@/db/client";
import { titles } from "@/db/schema";
import type * as schema from "@/db/schema";
import { fetchTmdbDetails, TmdbNotFoundError, type TmdbMediaType } from "./client";
import { mapTmdbDetails } from "./mapper";

export type MediaType = TmdbMediaType;

/** Anything drizzle's `db.transaction()` callback hands back, or the
 *  module-level `db` itself — lets callers (e.g. letterboxd/sync.ts, which
 *  writes inside its own transaction) pass their `tx` through instead of
 *  silently running outside it. */
type Executor = BetterSQLite3Database<typeof schema> | typeof db;

/** Inserts a minimal titles row if one doesn't already exist — same pattern
 *  as src/lib/plex/titlesStub.ts (that file is Phase 2's, kept independent
 *  here rather than importing across a phase boundary into a file that's
 *  still being actively written), but exported from Phase 3's module since
 *  Letterboxd ingestion needs the identical shape. onConflictDoNothing is
 *  correct *here* (unlike enrichTitle) because a stub, by definition, must
 *  never overwrite real data that's already there. */
export function ensureTitleStub(
  tmdbId: number,
  mediaType: MediaType,
  title: string,
  year?: number | null,
  executor: Executor = db,
): void {
  executor
    .insert(titles)
    .values({ tmdbId, mediaType, title: title || `Unknown (${tmdbId})`, year: year ?? undefined })
    .onConflictDoNothing({ target: [titles.tmdbId, titles.mediaType] })
    .run();
}

function getTitleRow(tmdbId: number, mediaType: MediaType) {
  return db
    .select()
    .from(titles)
    .where(and(eq(titles.tmdbId, tmdbId), eq(titles.mediaType, mediaType)))
    .get();
}

/** True once a title has gone through a real TMDB enrichment pass, as
 *  opposed to only ever having received a bare stub row. See file header
 *  for why this checks `genres` rather than row existence. */
export function isEnriched(tmdbId: number, mediaType: MediaType): boolean {
  const row = getTitleRow(tmdbId, mediaType);
  return row?.genres != null;
}

export interface EnrichOptions {
  /** Bypass the permanent cache and re-fetch even if already enriched. */
  force?: boolean;
}

/** Fetches full TMDB metadata for (tmdbId, mediaType) and upserts it into
 *  `titles`, filling in (or overwriting a previous enrichment of) every
 *  metadata column except `embedding`, which this module never touches.
 *  Permanently cached — a no-op if already enriched unless `force` is set.
 *  Throws TmdbNotFoundError / TmdbAuthError / TmdbRequestError from
 *  client.ts on failure; callers that must not let one title's enrichment
 *  failure abort a larger batch (e.g. letterboxd/sync.ts) should catch
 *  around this call. */
export async function enrichTitle(
  tmdbId: number,
  mediaType: MediaType,
  options: EnrichOptions = {},
): Promise<void> {
  if (!options.force && isEnriched(tmdbId, mediaType)) return;

  const details = await fetchTmdbDetails(tmdbId, mediaType);
  const mapped = mapTmdbDetails(details, mediaType);

  const values = {
    title: mapped.title,
    year: mapped.year ?? undefined,
    runtime: mapped.runtime ?? undefined,
    genres: JSON.stringify(mapped.genres),
    directors: JSON.stringify(mapped.directors),
    cast: JSON.stringify(mapped.cast),
    keywords: JSON.stringify(mapped.keywords),
    overview: mapped.overview ?? undefined,
    posterPath: mapped.posterPath ?? undefined,
    updatedAt: new Date(),
  };

  db.insert(titles)
    .values({ tmdbId, mediaType, ...values })
    // Explicit update-on-conflict, deliberately NOT onConflictDoNothing —
    // see file header. `embedding` is intentionally absent from `set` so an
    // existing Phase-5 vector is never overwritten by re-enrichment.
    .onConflictDoUpdate({
      target: [titles.tmdbId, titles.mediaType],
      set: values,
    })
    .run();
}

export { TmdbNotFoundError };
